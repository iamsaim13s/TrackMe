#!/usr/bin/env node
/**
 * 100-Day Tracker Wallpaper Generator
 * -------------------------------------------------------------
 * Renders a 10x10 dot-grid wallpaper sized for iPhone 12 Pro
 * (1170x2532 px, the physical pixel resolution of its display).
 *
 * One dot fills in per elapsed day since `startDate` in config.json.
 * Run daily (via GitHub Actions cron) to produce docs/wallpaper.png,
 * which is served by GitHub Pages at a stable URL an iOS Shortcut
 * downloads and sets as wallpaper.
 *
 * Usage:
 *   node scripts/generate.js
 *   node scripts/generate.js --date=2026-09-15   # override "today" for testing
 * -------------------------------------------------------------
 */

import { createCanvas } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const config = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

// ---- Date handling -------------------------------------------------------

function parseDateArg() {
  const arg = process.argv.find((a) => a.startsWith('--date='));
  return arg ? arg.split('=')[1] : null;
}

/** Returns YYYY-MM-DD for "today", using an override if passed, else system clock. */
function getTodayISO() {
  const override = parseDateArg();
  if (override) return override;
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/** Whole-day difference between two YYYY-MM-DD dates (UTC midnight based, DST-safe). */
function daysBetween(startISO, todayISO) {
  const start = new Date(`${startISO}T00:00:00Z`);
  const today = new Date(`${todayISO}T00:00:00Z`);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((today - start) / msPerDay);
}

const todayISO = getTodayISO();
const dayIndex = daysBetween(config.startDate, todayISO); // 0-based: 0 == start date == "Day 1"
const dayNumber = dayIndex + 1; // human "Day N"
const filledDots = Math.max(0, Math.min(config.totalDays, dayNumber));

console.log(`Start date : ${config.startDate}`);
console.log(`Today      : ${todayISO}`);
console.log(`Day        : ${dayNumber} / ${config.totalDays}`);
console.log(`Filled dots: ${filledDots}`);

// ---- Rendering ------------------------------------------------------------

const { width, height } = config.canvas;
const { cols, rows } = config.grid;
const { diameter, gapX, gapY, unfilledStrokeWidth } = config.dot;
const c = config.colors;

const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');

// Background
ctx.fillStyle = c.background;
ctx.fillRect(0, 0, width, height);

// Grid geometry: total block size, centered on canvas.
// Cell pitch = dot diameter + gap between dot edges.
const cellW = diameter + gapX;
const cellH = diameter + gapY;
const gridW = cols * diameter + (cols - 1) * gapX;
const gridH = rows * diameter + (rows - 1) * gapY;

const startX = (width - gridW) / 2;
const startY = (height - gridH) / 2;

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let dotCount = 0;
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    dotCount++;
    const cx = startX + col * cellW + diameter / 2;
    const cy = startY + row * cellH + diameter / 2;
    const radius = diameter / 2;

    const isFilled = dotCount <= filledDots;

    ctx.beginPath();
    ctx.arc(cx, cy, isFilled ? radius : radius - unfilledStrokeWidth / 2, 0, Math.PI * 2);

    if (isFilled) {
      ctx.fillStyle = c.dotFilled;
      ctx.fill();
    } else {
      ctx.strokeStyle = hexToRgba(c.dotUnfilledStroke, c.dotUnfilledStrokeOpacity);
      ctx.lineWidth = unfilledStrokeWidth;
      ctx.stroke();
    }
  }
}

// Optional day-counter text below the grid
if (config.showDayCounterText) {
  ctx.fillStyle = hexToRgba(c.textColor, c.textOpacity);
  ctx.font = '600 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`Day ${Math.min(dayNumber, config.totalDays)} / ${config.totalDays}`, width / 2, startY + gridH + 60);
}

// ---- Output -----------------------------------------------------------

const outDir = path.join(ROOT, 'docs');
await mkdir(outDir, { recursive: true });

const buffer = canvas.toBuffer('image/png');

// Stable filename an iOS Shortcut always fetches (overwritten daily).
await writeFile(path.join(outDir, 'wallpaper.png'), buffer);

// Dated archive copy, handy for debugging / history, doesn't break the stable URL.
await writeFile(path.join(outDir, `wallpaper-day-${String(filledDots).padStart(3, '0')}.png`), buffer);

// Small JSON status file, useful for the Shortcut or for debugging.
const status = {
  startDate: config.startDate,
  today: todayISO,
  dayNumber: Math.min(dayNumber, config.totalDays),
  totalDays: config.totalDays,
  filledDots,
  complete: filledDots >= config.totalDays,
  generatedAt: new Date().toISOString(),
};
await writeFile(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2));

console.log(`\nWrote docs/wallpaper.png (${width}x${height})`);
console.log(`Wrote docs/status.json`);
