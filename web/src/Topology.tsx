import { useEffect, useRef } from 'react';
import type { Position, Telemetry, RouteMode } from './types';

interface Props {
  positions: Position[];
  telemetry: Map<number, Telemetry>;
  mode: 'SIM' | 'LIVE';
  routeMode: RouteMode;
}

export default function Topology({ positions, telemetry, mode, routeMode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;

    const draw = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // bg grid
      ctx.fillStyle = 'rgba(8,11,16,1)';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(31,38,50,0.55)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // edges
      const gw = positions.find((p) => p.role === 2);
      if (gw) {
        for (const p of positions) {
          if (p.id === gw.id) continue;
          const t = telemetry.get(p.id);
          const nbr = t?.nbrs?.find((n) => n.id === gw.id);
          // pick metric by route mode
          let metric = -60, label = '-60';
          if (nbr) {
            if (routeMode === 0) { metric = nbr.rssi; label = `${metric}dBm`; }
            else                 { metric = -nbr.etx; label = `etx ${nbr.etx}`; }
          }
          const color = metric < -80 || (nbr && nbr.etx > 25) ? '#ef5350'
                      : metric < -70 || (nbr && nbr.etx > 15) ? '#ffb74d' : '#4dd0e1';
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.55;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(gw.x, gw.y); ctx.stroke();
          ctx.globalAlpha = 1;
          // midpoint label
          ctx.fillStyle = 'rgba(230,237,243,0.7)';
          ctx.font = "11px 'IBM Plex Mono', monospace";
          const mx = (p.x + gw.x) / 2, my = (p.y + gw.y) / 2;
          ctx.fillText(label, mx - 18, my - 6);
        }
      }

      // nodes
      for (const p of positions) {
        const t = telemetry.get(p.id);
        const bat = t?.bat ?? 100;
        const isGw = p.role === 2;
        const isRisk = (t?.rssi !== undefined && t.rssi < -75) || bat < 20;
        const r = isGw ? 18 : 14;
        // glow
        const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, r * 2.4);
        g.addColorStop(0, isRisk ? 'rgba(239,83,80,0.55)' : 'rgba(77,208,225,0.45)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2); ctx.fill();
        // body
        ctx.fillStyle = isRisk ? '#ef5350' : isGw ? '#00bcd4' : '#4dd0e1';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0a0d12'; ctx.lineWidth = 2; ctx.stroke();
        // label
        ctx.fillStyle = '#e6edf3';
        ctx.font = "600 12px 'Inter', sans-serif";
        ctx.fillText(p.name, p.x + r + 6, p.y - 2);
        ctx.font = "11px 'IBM Plex Mono', monospace";
        ctx.fillStyle = '#8b95a4';
        ctx.fillText(`#${p.id} · ${bat}%`, p.x + r + 6, p.y + 12);
      }

      // mode badge
      ctx.fillStyle = 'rgba(20,26,36,0.85)';
      ctx.fillRect(12, 12, 130, 28);
      ctx.strokeStyle = '#1f2632'; ctx.strokeRect(12, 12, 130, 28);
      ctx.fillStyle = '#e6edf3';
      ctx.font = "600 12px 'Inter'";
      ctx.fillText(`${mode} · ${routeMode === 0 ? 'RSSI' : 'ETX'}`, 22, 31);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [positions, telemetry, mode, routeMode]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}