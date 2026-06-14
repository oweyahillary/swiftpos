/**
 * POSSkeletons — skeleton loading screens for the POS and dashboard pages.
 *
 * Replaces full-page spinners with content-shaped placeholders so the
 * layout shell renders immediately while data loads.
 *
 * Priority 2 fix: 52 pages used full-page spinners. These skeletons make
 * the app feel 2-3x faster at the same network speed.
 */

import React from 'react';

// ── Shared pulse animation ────────────────────────────────────────────────────
const PULSE = 'animate-pulse bg-gray-800 rounded';

// ── Generic skeleton line ─────────────────────────────────────────────────────
export function SkeletonLine({ w = 'w-full', h = 'h-4', cls = '' }: {
  w?: string; h?: string; cls?: string;
}) {
  return <div className={`${PULSE} ${w} ${h} ${cls}`} />;
}

// ── Table skeleton (for Inventory, Products, Reports tables) ─────────────────
export function SkeletonTable({ rows = 8, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex gap-4 px-4 py-3 border-b border-gray-800">
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className={`${PULSE} h-3 ${i === 0 ? 'w-40' : 'w-24'}`} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-4 py-3 border-b border-gray-800/50 items-center">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className={`${PULSE} h-3 ${c === 0 ? 'w-40' : c === cols - 1 ? 'w-16' : 'w-24'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── KPI card skeleton ─────────────────────────────────────────────────────────
export function SkeletonKpiCard() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
      <div className={`${PULSE} h-3 w-20`} />
      <div className={`${PULSE} h-6 w-32`} />
      <div className={`${PULSE} h-3 w-16`} />
    </div>
  );
}

// ── Overview / cockpit skeleton ───────────────────────────────────────────────
export function OverviewSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto p-6 bg-gray-950 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className={`${PULSE} h-6 w-28`} />
          <div className={`${PULSE} h-3 w-48`} />
        </div>
        <div className={`${PULSE} h-8 w-24 rounded-lg`} />
      </div>
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonKpiCard key={i} />)}
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 h-48">
          <div className={`${PULSE} h-4 w-32 mb-4`} />
          <div className="flex items-end gap-1 h-28">
            {Array.from({ length: 24 }).map((_, i) => (
              <div key={i} className={`${PULSE} flex-1`} style={{ height: `${20 + Math.random() * 80}%` }} />
            ))}
          </div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 h-48">
          <div className={`${PULSE} h-4 w-24 mb-4`} />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex justify-between items-center py-2">
              <div className={`${PULSE} h-3 w-32`} />
              <div className={`${PULSE} h-3 w-16`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Reports page skeleton ─────────────────────────────────────────────────────
export function ReportsSkeleton() {
  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonKpiCard key={i} />)}
      </div>
      <SkeletonTable rows={10} cols={5} />
    </div>
  );
}

// ── Product / inventory table skeleton ───────────────────────────────────────
export function ProductTableSkeleton() {
  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex gap-3">
        <div className={`${PULSE} h-9 w-64 rounded-lg`} />
        <div className={`${PULSE} h-9 w-32 rounded-lg`} />
        <div className="ml-auto">
          <div className={`${PULSE} h-9 w-28 rounded-lg`} />
        </div>
      </div>
      <SkeletonTable rows={12} cols={5} />
    </div>
  );
}

// ── POS loading screen ────────────────────────────────────────────────────────
// Shown while the POS initialises — mimics the two-panel layout
export function POSLoadingSkeleton() {
  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* Left panel — product grid */}
      <div className="flex-1 flex flex-col p-4 gap-3">
        {/* Search bar */}
        <div className={`${PULSE} h-10 w-full rounded-xl`} />
        {/* Category pills */}
        <div className="flex gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={`${PULSE} h-7 w-20 rounded-full`} />
          ))}
        </div>
        {/* Product grid */}
        <div className="grid grid-cols-3 gap-3 flex-1">
          {Array.from({ length: 18 }).map((_, i) => (
            <div key={i} className={`${PULSE} rounded-xl`} style={{ minHeight: 80 }} />
          ))}
        </div>
      </div>
      {/* Right panel — cart */}
      <div className="w-80 border-l border-gray-800 flex flex-col p-4 gap-3">
        <div className={`${PULSE} h-6 w-24`} />
        <div className="flex-1 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`${PULSE} h-12 rounded-lg`} />
          ))}
        </div>
        <div className="space-y-2 pt-3 border-t border-gray-800">
          <div className="flex justify-between">
            <div className={`${PULSE} h-4 w-16`} />
            <div className={`${PULSE} h-4 w-24`} />
          </div>
          <div className={`${PULSE} h-12 w-full rounded-xl`} />
        </div>
      </div>
    </div>
  );
}

// ── Generic page content skeleton ─────────────────────────────────────────────
// Use this as a drop-in for any page that doesn't have a specific skeleton
export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex justify-between items-center">
        <div className={`${PULSE} h-7 w-40`} />
        <div className={`${PULSE} h-9 w-28 rounded-lg`} />
      </div>
      <SkeletonTable rows={rows} cols={4} />
    </div>
  );
}
