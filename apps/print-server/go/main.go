// SwiftPOS Print Bridge (Go) — a tiny local HTTP server that writes ESC/POS bytes
// to a printer. The browser renders the receipt (shared/printing) and POSTs the
// bytes here; this process just forwards them. That keeps the binary a few MB
// instead of ~55 MB (no embedded JS runtime).
//
// API (matches the previous Node bridge so the dashboard is unchanged except that
// it now sends bytes, not an order):
//   GET  /health   -> {ok, version, requiresToken}          (no token needed)
//   POST /print    {target, data: base64 ESC/POS}           (X-Print-Token required)
//
// Security: loopback-only, an exact-origin allowlist, and a pairing token stored
// at ~/.swiftpos-print-bridge-token (printed on first run).
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

const version = "3.0.0"

var allowedOrigins = map[string]bool{}
var token string

func main() {
	port := "3001"
	if p := os.Getenv("PRINT_BRIDGE_PORT"); p != "" {
		port = p
	}
	for _, o := range []string{
		"http://localhost:5173", "http://localhost:4173", "http://localhost:3000",
		"http://127.0.0.1:5173", "http://127.0.0.1:4173", "http://127.0.0.1:3000",
	} {
		allowedOrigins[o] = true
	}
	for _, o := range strings.Split(os.Getenv("PRINT_BRIDGE_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowedOrigins[o] = true
		}
	}
	token = loadToken()

	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/print", handlePrint)

	addr := "127.0.0.1:" + port
	fmt.Printf("SwiftPOS Print Bridge %s on http://%s\n", version, addr)
	fmt.Printf("Bound to loopback only. Not reachable from the network.\n\n")
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

func cors(w http.ResponseWriter, origin string) bool {
	if origin != "" && !allowedOrigins[origin] {
		return false
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Print-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func tokenOK(given string) bool {
	if given == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(token)) == 1
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !cors(w, origin) {
		writeJSON(w, 403, map[string]any{"error": "origin not allowed"})
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": version, "requiresToken": true})
}

func handlePrint(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !cors(w, origin) {
		writeJSON(w, 403, map[string]any{"error": "origin not allowed"})
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "POST only"})
		return
	}
	if !tokenOK(r.Header.Get("X-Print-Token")) {
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
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "data is not valid base64"})
		return
	}
	if len(bytes) == 0 {
		writeJSON(w, 400, map[string]any{"error": "data is empty"})
		return
	}
	started := time.Now()
	if err := sendToPrinter(body.Target, bytes); err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "bytes": len(bytes), "ms": time.Since(started).Milliseconds()})
}

// sendToPrinter parses the target the same way the old bridge did and writes the
// raw bytes to it.
//
//	printer:<name>  -> Windows spooler, RAW datatype (USB/installed printers)
//	\\host\name     -> Windows share (write as a file)
//	/dev/...        -> unix device node
//	host[:port]     -> raw TCP (network printer, default :9100)
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
