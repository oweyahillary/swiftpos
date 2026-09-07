// SwiftPOS Print Bridge (Go) — a tiny (~1.6 MB) local byte-forwarder.
// The browser renders the receipt to ESC/POS and POSTs the bytes here; this
// process writes them to the printer. No embedded JS runtime → tiny.
//
// API:
//   GET  /health   -> {ok, version}                         (open)
//   GET  /printers -> {printers: [names]}                    (open; Windows spooler)
//   POST /print       {target, data: base64 ESC/POS}        (X-Print-Token)
//   POST /print/test  {target|printer, paperWidth}          (X-Print-Token)
//
// target: "printer:<name>" (Windows spooler/USB) · "\\host\name" (share) ·
//         "/dev/..." (unix) · "host[:port]" (network, default :9100).
//
// Security: loopback-only + a pairing token (~/.swiftpos-print-bridge-token,
// printed on first run) required for the print endpoints. CORS is open (any
// origin) because the token — not the origin — is what protects printing; this
// removes per-deployment origin configuration.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const version = "4.1.0"

var token string

func main() {
	port := "9911"
	if p := os.Getenv("PRINT_BRIDGE_PORT"); p != "" {
		port = p
	}
	token = loadToken()

	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/printers", handlePrinters)
	http.HandleFunc("/print", handlePrint)
	http.HandleFunc("/print/test", handleTest)

	addr := "127.0.0.1:" + port
	fmt.Printf("SwiftPOS Print Bridge %s on http://%s\n", version, addr)
	fmt.Printf("Bound to loopback only; Host-locked to localhost (DNS-rebinding safe).\n\n")
	fmt.Printf("Pair token (paste into the till's printer settings):\n   %s\n\n", token)
	fmt.Printf("Stored at %s. Delete it and restart to rotate.\n", tokenPath())
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Fprintln(os.Stderr, "listen error:", err)
		os.Exit(1)
	}
}

func tokenPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".swiftpos-print-bridge-token")
}

func loadToken() string {
	p := tokenPath()
	if b, err := os.ReadFile(p); err == nil {
		if t := strings.TrimSpace(string(b)); len(t) >= 32 {
			return t
		}
	}
	raw := make([]byte, 24)
	_, _ = rand.Read(raw)
	t := base64.RawURLEncoding.EncodeToString(raw)
	_ = os.WriteFile(p, []byte(t), 0o600)
	return t
}

// hostOK defeats DNS-rebinding. Loopback binding stops the network reaching us,
// but a malicious web page can rebind its own hostname to 127.0.0.1 and drive
// this process from the victim's browser; the browser sends that page's hostname
// in the Host header, so we reject anything that is not our own loopback address.
// Standard defence for a browser-reachable local daemon over plain HTTP (the
// token is auth; this is the second wall). Applied to EVERY endpoint.
func hostOK(r *http.Request) bool {
	h := strings.ToLower(strings.TrimSpace(r.Host))
	if h == "" {
		return false
	}
	host := h
	if i := strings.LastIndex(h, ":"); i > 0 && !strings.Contains(h, "]") {
		host = h[:i]
	}
	switch host {
	case "127.0.0.1", "localhost", "[::1]", "::1":
		return true
	}
	return false
}

// cors reflects the request origin (open) and short-circuits preflight.
func cors(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Print-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func tokenOK(r *http.Request) bool {
	g := r.Header.Get("X-Print-Token")
	if g == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(g), []byte(token)) == 1
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if !hostOK(r) {
		writeJSON(w, 403, map[string]any{"error": "bad host"})
		return
	}
	if !cors(w, r) {
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": version})
}

func handlePrinters(w http.ResponseWriter, r *http.Request) {
	if !hostOK(r) {
		writeJSON(w, 403, map[string]any{"error": "bad host"})
		return
	}
	if !cors(w, r) {
		return
	}
	if !tokenOK(r) {
		writeJSON(w, 401, map[string]any{"error": "missing or invalid X-Print-Token"})
		return
	}
	names, err := listPrinters()
	if err != nil {
		writeJSON(w, 200, map[string]any{"printers": []string{}, "note": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"printers": names})
}

func handlePrint(w http.ResponseWriter, r *http.Request) {
	if !hostOK(r) {
		writeJSON(w, 403, map[string]any{"error": "bad host"})
		return
	}
	if !cors(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "POST only"})
		return
	}
	if !tokenOK(r) {
		writeJSON(w, 401, map[string]any{"error": "missing or invalid X-Print-Token"})
		return
	}
	var body struct {
		Target string `json:"target"`
		Data   string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad json: " + err.Error()})
		return
	}
	if body.Target == "" || body.Data == "" {
		writeJSON(w, 400, map[string]any{"error": "target and data (base64 ESC/POS) are required"})
		return
	}
	bytes, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil || len(bytes) == 0 {
		writeJSON(w, 400, map[string]any{"error": "data is not valid base64 or is empty"})
		return
	}
	started := time.Now()
	if err := sendToPrinter(body.Target, bytes); err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "bytes": len(bytes), "ms": time.Since(started).Milliseconds()})
}

func handleTest(w http.ResponseWriter, r *http.Request) {
	if !hostOK(r) {
		writeJSON(w, 403, map[string]any{"error": "bad host"})
		return
	}
	if !cors(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "POST only"})
		return
	}
	if !tokenOK(r) {
		writeJSON(w, 401, map[string]any{"error": "missing or invalid X-Print-Token"})
		return
	}
	var body struct {
		Target  string `json:"target"`
		Printer string `json:"printer"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	target := body.Target
	if target == "" && body.Printer != "" {
		target = "printer:" + body.Printer
	}
	if target == "" {
		writeJSON(w, 400, map[string]any{"error": "target or printer required"})
		return
	}
	if err := sendToPrinter(target, testTicket()); err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// testTicket is a minimal ESC/POS test receipt (init, text, feed, cut).
func testTicket() []byte {
	esc := []byte{0x1b, 0x40} // ESC @ init
	esc = append(esc, []byte("\n   SwiftPOS print test\n   ")...)
	esc = append(esc, []byte(time.Now().Format("2006-01-02 15:04:05"))...)
	esc = append(esc, []byte("\n\n   If you can read this,\n   silent printing works.\n\n\n")...)
	esc = append(esc, 0x1d, 0x56, 0x00) // GS V 0 full cut
	return esc
}

func sendToPrinter(spec string, data []byte) error {
	switch {
	case strings.HasPrefix(spec, "printer:"):
		name := strings.TrimSpace(spec[len("printer:"):])
		if name == "" {
			return fmt.Errorf("printer: needs a printer name after it")
		}
		return sendSpooler(name, data)
	case strings.HasPrefix(spec, `\\`):
		return sendFile(spec, data)
	case strings.HasPrefix(spec, "/"):
		return sendFile(spec, data)
	default:
		host := spec
		port := 9100
		if i := strings.LastIndex(spec, ":"); i > 0 {
			host = spec[:i]
			if p, err := strconv.Atoi(spec[i+1:]); err == nil {
				port = p
			}
		}
		if host == "" {
			return fmt.Errorf("cannot parse printer target %q", spec)
		}
		return sendNetwork(host, port, data)
	}
}

func sendNetwork(host string, port int, data []byte) error {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 5*time.Second)
	if err != nil {
		return fmt.Errorf("connect %s:%d: %w", host, port, err)
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err = conn.Write(data)
	return err
}

func sendFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
}
