# SwiftPOS Print Server

A lightweight local print server for SwiftPOS. Enables silent one-click printing
from any browser (Chrome, Firefox, Edge, Safari) to any printer (USB, Ethernet, Bluetooth).

## How it works

```
Browser → POST http://localhost:3001/print → Print Server → Windows/Mac Printer
```

The SwiftPOS dashboard automatically detects this server. When running, receipts
and KOTs print instantly with no dialog. When not running, SwiftPOS falls back
to the browser's built-in print dialog.

## Installation — Windows (recommended)

### Option A: Install as a Windows Service (auto-starts on boot)

1. Download `SwiftPOS-PrintServer.exe` and `install-windows-service.bat`
   into the same folder (e.g. `C:\SwiftPOS\PrintServer\`)
2. Right-click `install-windows-service.bat` → **Run as administrator**
3. Done. The server starts automatically every time Windows boots.

### Option B: Run manually (for testing)

Double-click `SwiftPOS-PrintServer.exe`. Keep the window open while using SwiftPOS.

## Installation — Mac

```bash
# Run directly
./SwiftPOS-PrintServer-macos

# Or install as a launchd service (auto-start on boot)
# Copy the plist file and load it
cp com.swiftpos.printserver.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.swiftpos.printserver.plist
```

## Installation — Linux

```bash
chmod +x SwiftPOS-PrintServer-linux
./SwiftPOS-PrintServer-linux

# Or install as a systemd service
sudo cp swiftpos-printserver.service /etc/systemd/system/
sudo systemctl enable swiftpos-printserver
sudo systemctl start swiftpos-printserver
```

## API

### GET /health
Returns server status and list of available printers.

```json
{
  "ok": true,
  "version": "1.0.0",
  "platform": "win32",
  "printers": ["EPSON TM-T20III", "Star TSP100"]
}
```

### GET /printers
Returns list of all printers installed on this computer.

### POST /print
Sends a print job.

```json
{
  "printer": "EPSON TM-T20III",
  "content": "<html receipt content>",
  "paperWidth": 80,
  "copies": 1,
  "autoCut": true
}
```

### POST /print/test
Prints a test page to verify the printer is working.

```json
{
  "printer": "EPSON TM-T20III",
  "paperWidth": 80
}
```

## Troubleshooting

**"Print Server Not Connected" in SwiftPOS**
- Make sure the print server is running (check system tray or services)
- Check Windows Firewall isn't blocking port 3001
- Try opening http://localhost:3001/health in your browser

**Print job sent but nothing printed**
- Check the printer is online and has paper
- Try the test print from SwiftPOS Settings → Printers
- Make sure the printer name matches exactly (copy from the dropdown)

**Port 3001 already in use**
- Another instance may already be running
- Check Windows Services for "SwiftPOS Print Server"

## Building from source

```bash
cd print-server
npm install
npm run build:win      # Windows .exe only
npm run build:all      # All platforms
```

Requires Node.js 18+ and pkg installed globally (`npm install -g pkg`).
