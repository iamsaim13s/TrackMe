#!/usr/bin/env node
/**
 * 100-Day Tracker Wallpaper Generator
 * -------------------------------------------------------------
 * Renders a 10x10 grid-cell wallpaper sized for iPhone 12 Pro
 * (1170x2532 px, the physical pixel resolution of its display).
 *
 * One cell fills in per elapsed day since `startDate` in config.json.
 * Run daily (via GitHub Actions cron) to produce docs/wallpaper.png,
 * which is served by GitHub Pages at a stable URL an iOS Shortcut
 * downloads and sets as wallpaper.
 *
 * Design: deep navy/near-black vertical gradient background with a
 * soft vignette and subtle procedural grain, a 10x10 grid of rounded
 * "cells" (filled = solid white with a soft accent glow, unfilled =
 * faint translucent outline), the current day's cell highlighted with
 * an accent ring, a thin progress bar, and minimal header/footer text
 * (label, day counter, date range, percentage). Everything is drawn
 * procedurally with the canvas API — no external assets, no network
 * calls, deterministic output.
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

function formatDisplayDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const todayISO = getTodayISO();
const dayIndex = daysBetween(config.startDate, todayISO); // 0-based: 0 == start date == "Day 1"
const dayNumber = dayIndex + 1; // human "Day N"
const filledDots = Math.max(0, Math.min(config.totalDays, dayNumber));
const clampedDayNumber = Math.max(1, Math.min(config.totalDays, dayNumber));
const isComplete = filledDots >= config.totalDays;
// "Today" only highlights a real, in-range day (not before start / after completion).
const todayCellIndex = dayNumber >= 1 && dayNumber <= config.totalDays ? dayNumber : null;
const endDateISO = addDaysISO(config.startDate, config.totalDays - 1);

console.log(`Start date : ${config.startDate}`);
console.log(`Today      : ${todayISO}`);
console.log(`Day        : ${dayNumber} / ${config.totalDays}`);
console.log(`Filled dots: ${filledDots}`);

// ---- Helpers ---------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Deterministic pseudo-random generator (mulberry32) so the grain texture
// is stable/reproducible across renders rather than truly random noise.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Setup ------------------------------------------------------------

const { width, height } = config.canvas;
const { cols, rows } = config.grid;
const { size, cornerRadius, gapX, gapY, unfilledStrokeWidth, todayScale } = config.cell;
const layout = config.layout;
const c = config.colors;
const t = config.text;

const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');

// ---- Background: vertical gradient + vignette + grain ---------------------

const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
bgGradient.addColorStop(0, c.backgroundTop);
bgGradient.addColorStop(1, c.backgroundBottom);
ctx.fillStyle = bgGradient;
ctx.fillRect(0, 0, width, height);

// Soft radial vignette focused where the grid sits, darkening the edges
// so the design reads calmly behind a clock/notifications or app icons.
const vignette = ctx.createRadialGradient(
  width / 2, height / 2, height * 0.15,
  width / 2, height / 2, height * 0.72
);
vignette.addColorStop(0, 'rgba(0,0,0,0)');
vignette.addColorStop(1, `rgba(0,0,0,${c.vignetteOpacity})`);
ctx.fillStyle = vignette;
ctx.fillRect(0, 0, width, height);

// Subtle procedural grain to avoid flat/banded gradients on OLED.
if (c.noiseOpacity > 0) {
  const rand = mulberry32(20260901); // fixed seed = deterministic output
  const grainCount = Math.round((width * height) / 900);
  ctx.fillStyle = `rgba(255,255,255,${c.noiseOpacity})`;
  for (let i = 0; i < grainCount; i++) {
    const x = rand() * width;
    const y = rand() * height;
    ctx.fillRect(x, y, 1, 1);
  }
}

// ---- Grid geometry: centered within the safe area between header/footer ---

const cellPitchX = size + gapX;
const cellPitchY = size + gapY;
const gridW = cols * size + (cols - 1) * gapX;
const gridH = rows * size + (rows - 1) * gapY;

const safeTop = layout.topSafeArea;
const safeBottom = height - layout.bottomSafeArea;
const safeH = safeBottom - safeTop;

// Reserve room for header text (top) and footer text + progress bar (bottom)
// within the safe area, then vertically center the grid in what's left.
const headerH = t.showHeader ? 40 : 0;
const footerH = (t.showDayCounter || t.showDateRange || t.showPercentage ? 60 : 0) +
  (layout.progressBarHeight + layout.footerGap);

const contentH = headerH + (headerH ? layout.headerGap : 0) + gridH + layout.footerGap + footerH;
const contentTop = safeTop + Math.max(0, (safeH - contentH) / 2);

const startX = (width - gridW) / 2;
let cursorY = contentTop;

if (t.showHeader) {
  ctx.fillStyle = hexToRgba(c.textColor, c.textSecondaryOpacity);
  ctx.font = '600 30px Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Letter-spaced label, drawn manually since canvas has no letter-spacing prop.
  drawTrackedText(ctx, t.headerLabel, width / 2, cursorY, 6);
  cursorY += headerH + layout.headerGap;
}

const startY = cursorY;

function drawTrackedText(context, str, centerX, y, spacing) {
  const chars = str.split('');
  const widths = chars.map((ch) => context.measureText(ch).width);
  const totalW = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let x = centerX - totalW / 2;
  const prevAlign = context.textAlign;
  context.textAlign = 'left';
  for (let i = 0; i < chars.length; i++) {
    context.fillText(chars[i], x, y);
    x += widths[i] + spacing;
  }
  context.textAlign = prevAlign;
}

// ---- Draw the 10x10 cell grid ----------------------------------------------

let cellCount = 0;
for (let row = 0; row < rows; row++) {
  for (let col = 0; col < cols; col++) {
    cellCount++;
    const baseX = startX + col * cellPitchX;
    const baseY = startY + row * cellPitchY;
    const cx = baseX + size / 2;
    const cy = baseY + size / 2;

    const isFilled = cellCount <= filledDots;
    const isToday = cellCount === todayCellIndex;

    const scale = isToday ? todayScale : 1;
    const drawSize = size * scale;
    const drawX = cx - drawSize / 2;
    const drawY = cy - drawSize / 2;
    const drawRadius = cornerRadius * scale;

    if (isFilled) {
      // Soft glow behind filled cells for a gentle luminous feel.
      ctx.save();
      ctx.shadowColor = hexToRgba(c.dotFilledGlow, c.dotFilledGlowOpacity);
      ctx.shadowBlur = 18;
      roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
      ctx.fillStyle = c.dotFilled;
      ctx.fill();
      ctx.restore();
    } else {
      roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
      ctx.fillStyle = hexToRgba(c.dotUnfilledFill, c.dotUnfilledFillOpacity);
      ctx.fill();
      ctx.lineWidth = unfilledStrokeWidth;
      ctx.strokeStyle = hexToRgba(c.dotUnfilledStroke, c.dotUnfilledStrokeOpacity);
      ctx.stroke();
    }

    // Highlight ring around "today"'s cell, regardless of filled state,
    // so the current day is always glanceable on the lock screen.
    if (isToday) {
      ctx.save();
      const ringPad = 7;
      roundedRectPath(
        ctx,
        drawX - ringPad,
        drawY - ringPad,
        drawSize + ringPad * 2,
        drawSize + ringPad * 2,
        drawRadius + ringPad
      );
      ctx.lineWidth = 3;
      ctx.strokeStyle = hexToRgba(c.todayRingColor, c.todayRingOpacity);
      ctx.stroke();
      ctx.restore();
    }
  }
}

const gridBottom = startY + gridH;

// ---- Progress bar -----------------------------------------------------

const percent = filledDots / config.totalDays;
const barW = gridW * layout.progressBarWidthRatio;
const barX = width / 2 - barW / 2;
const barY = gridBottom + layout.footerGap;
const barH = layout.progressBarHeight;

roundedRectPath(ctx, barX, barY, barW, barH, barH / 2);
ctx.fillStyle = hexToRgba(c.progressTrackColor, c.progressTrackOpacity);
ctx.fill();

if (percent > 0) {
  const fillW = Math.max(barH, barW * percent);
  roundedRectPath(ctx, barX, barY, fillW, barH, barH / 2);
  ctx.save();
  ctx.shadowColor = hexToRgba(c.accent, 0.6);
  ctx.shadowBlur = 12;
  ctx.fillStyle = c.progressFillColor;
  ctx.fill();
  ctx.restore();
}

// ---- Footer text: day counter / date range / percentage -------------------

let footerY = barY + barH + 26;

if (t.showDayCounter) {
  ctx.fillStyle = hexToRgba(c.textColor, c.textPrimaryOpacity);
  ctx.font = '700 46px Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const label = isComplete ? `DAY ${config.totalDays} · COMPLETE` : `DAY ${clampedDayNumber} / ${config.totalDays}`;
  ctx.fillText(label, width / 2, footerY);
  footerY += 56;
}

const subParts = [];
if (t.showDateRange) subParts.push(`${formatDisplayDate(config.startDate)} – ${formatDisplayDate(endDateISO)}`);
if (t.showPercentage) subParts.push(`${Math.round(percent * 100)}%`);

if (subParts.length) {
  ctx.fillStyle = hexToRgba(c.textColor, c.textSecondaryOpacity);
  ctx.font = '500 28px Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(subParts.join('   ·   '), width / 2, footerY);
}

// (Legacy single-line toggle kicks in only if the structured footer above is
// fully disabled, so older configs relying on `showDayCounterText` still work.)
if (config.showDayCounterText && !t.showDayCounter && !t.showDateRange && !t.showPercentage) {
  ctx.fillStyle = hexToRgba(c.textColor, c.textSecondaryOpacity);
  ctx.font = '600 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`Day ${clampedDayNumber} / ${config.totalDays}`, width / 2, gridBottom + layout.footerGap);
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
  dayNumber: clampedDayNumber,
  totalDays: config.totalDays,
  filledDots,
  complete: isComplete,
  generatedAt: new Date().toISOString(),
};
await writeFile(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2));

console.log(`\nWrote docs/wallpaper.png (${width}x${height})`);
console.log(`Wrote docs/status.json`);
