/**
 * ServerAddressAsk — A507: Find my server, when the network hides the server.
 *
 * Owner, 2026-10-16 (on A502's "no typed address", told that a Windows network set to Public or Wi-Fi that keeps devices
 * apart blocks the server's broadcast): "I will go with your recommendation" — a technician may type the server's address
 * INSIDE Find my server, only when it found nothing. It is not the old typed address: it does not save anything — it asks
 * that machine to let this till join, exactly as a server found on the network (install:requestJoin), so someone at the
 * server still presses Allow, the till still checks the server's certificate, and the access code and device key still
 * come from the server's answer.
 */
import { useState } from 'react';
import type { FoundServer } from '../lib/posApi';

const PORT = 4100;   // nodeServer.ts NODE_PORT; a server that had to move says so on its Tech page
const LAN = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export default function ServerAddressAsk({ onAsk, disabled, dark = false }: { onAsk: (srv: FoundServer) => void; disabled?: boolean; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState('');
  const [port, setPort] = useState(String(PORT));
  const ipT = ip.trim();
  const ipOk = /^(\d{1,3}\.){3}\d{1,3}$/.test(ipT) && ipT.split('.').every((o) => Number(o) <= 255) && LAN.test(ipT);
  const portN = Number(port);
  const portOk = Number.isInteger(portN) && portN >= 1024 && portN <= 65535;
  const field = dark
    ? 'bg-[#0a0f1c] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono'
    : 'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono';

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-action-400 hover:text-action-300" data-testid="server-address-open">
        Server not found? Enter its address
      </button>
    );
  }
  return (
    <div className="space-y-2" data-testid="server-address-ask">
      <p className="text-[11px] text-gray-400">
        The server&apos;s address is on its Tech page (Branch server). Someone at the server is still asked to press Allow.
      </p>
      <div className="flex gap-2">
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.20" inputMode="decimal" spellCheck={false}
          className={`${field} flex-1`} />
        <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} maxLength={5} inputMode="numeric"
          className={`${field} w-20`} />
      </div>
      {ipT !== '' && !ipOk && (
        <p className="text-[11px] text-amber-300">Enter the server&apos;s address on the shop network — it looks like 192.168.1.20.</p>
      )}
      <button type="button" disabled={disabled || !ipOk || !portOk}
        onClick={() => onAsk({ url: `http://${ipT}:${portN}`, ip: ipT, port: portN, business: null, server: null })}
        className="w-full bg-[#1e293b] hover:bg-[#26344b] disabled:opacity-40 text-gray-200 rounded-lg py-2 text-sm">
        Ask this server
      </button>
    </div>
  );
}
