#!/usr/bin/env node
/**
 * 100-Day Tracker Wallpaper Generator
 * -------------------------------------------------------------
 * Renders one or more grid-cell wallpapers, one per tracker defined in
 * config.json's `trackers` array. Each tracker has its own start date,
 * day count, canvas size (device dimensions), colors, and layout — so
 * multiple people/devices can be tracked from one config file, each
 * producing its own output PNG (docs/<outputName>.png).
 *
 * One cell fills in per elapsed day since a tracker's `startDate`.
 * Run daily (via GitHub Actions cron) to regenerate every tracker's PNG,
 * all served by GitHub Pages at stable per-tracker URLs an iOS Shortcut
 * downloads and sets as wallpaper.
 *
 * Design: deep gradient background with a soft vignette and subtle
 * procedural grain, a 10x10 grid of rounded "cells" with layered depth
 * shading (cast shadow, glow, top-edge highlight for filled cells;
 * recessed inset look for unfilled cells; single consistent light
 * source), the current day's cell highlighted with an accent ring, an
 * optional thin progress bar, and optional minimal header/footer text.
 * Everything is drawn procedurally with the canvas API — no external
 * assets, no network calls, deterministic output.
 *
 * Usage:
 *   node scripts/generate.js
 *   node scripts/generate.js --date=2026-09-15   # override "today" for testing
 *   node scripts/generate.js --only=a   # render just one tracker by id
 * -------------------------------------------------------------
 */

import { createCanvas } from '@napi-rs/canvas';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const rootConfig = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

// ---- CLI args --------------------------------------------------------------

function parseArg(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
}

const dateOverride = parseArg('date');
const onlyId = parseArg('only');

// ---- Date helpers ------------------------------------------------------------

/** Returns YYYY-MM-DD for "today", using an override if passed, else system clock. */
function getTodayISO() {
  if (dateOverride) return dateOverride;
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

// ---- Drawing helpers ---------------------------------------------------------

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

// ---- Render one tracker's wallpaper -------------------------------------------

async function renderTracker(config, todayISO) {
  const dayIndex = daysBetween(config.startDate, todayISO); // 0-based: 0 == start date == "Day 1"
  const dayNumber = dayIndex + 1; // human "Day N"
  const filledDots = Math.max(0, Math.min(config.totalDays, dayNumber));
  const clampedDayNumber = Math.max(1, Math.min(config.totalDays, dayNumber));
  const isComplete = filledDots >= config.totalDays;
  // "Today" only highlights a real, in-range day (not before start / after completion).
  const todayCellIndex = dayNumber >= 1 && dayNumber <= config.totalDays ? dayNumber : null;
  const endDateISO = addDaysISO(config.startDate, config.totalDays - 1);

  console.log(`[${config.id}] Start date : ${config.startDate}`);
  console.log(`[${config.id}] Today      : ${todayISO}`);
  console.log(`[${config.id}] Day        : ${dayNumber} / ${config.totalDays}`);
  console.log(`[${config.id}] Filled dots: ${filledDots}`);

  const { width, height } = config.canvas;
  const { cols, rows } = config.grid;
  const { size, cornerRadius, gapX, gapY, unfilledStrokeWidth, todayScale, depth, lightAngleDeg } = config.cell;
  const lightRad = ((lightAngleDeg ?? 60) * Math.PI) / 180;
  const lightDX = Math.cos(lightRad); // light-source direction; shadows fall opposite this
  const lightDY = Math.sin(lightRad);
  const layout = config.layout;
  const c = config.colors;
  const t = config.text;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ---- Background: vertical gradient + vignette + grain -------------------

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

  // ---- Grid geometry: centered within the safe area between header/footer -

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
    (t.showProgressBar ? layout.progressBarHeight + layout.footerGap : 0);

  const contentH = headerH + (headerH ? layout.headerGap : 0) + gridH + (footerH ? layout.footerGap : 0) + footerH;
  const centeredTop = safeTop + Math.max(0, (safeH - contentH) / 2);
  // Shift the whole content block down from center by `verticalOffset` px,
  // clamped so it never pushes past the bottom safe area.
  const maxTop = safeBottom - contentH;
  const contentTop = Math.min(centeredTop + (layout.verticalOffset ?? 0), Math.max(safeTop, maxTop));

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

  // ---- Draw the grid ------------------------------------------------------

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

      // Depth for a filled cell = it has "risen" off the surface (full shadow
      // throw + glow + a bright top-edge highlight, like a lit, raised tile).
      // An unfilled cell sits flush/recessed into the surface (a faint inset
      // shadow along its light-facing edge, no cast shadow) — a single
      // consistent light source ties both states into one spatial scene.
      const cellDepth = isFilled ? depth * scale : depth * 0.28;

      if (isFilled) {
        // 1) Soft ambient contact shadow cast opposite the light direction —
        //    the primary cue that this tile floats above the background.
        ctx.save();
        ctx.shadowColor = hexToRgba(c.shadowColor, c.shadowOpacity);
        ctx.shadowBlur = cellDepth * 2.6;
        ctx.shadowOffsetX = lightDX * cellDepth;
        ctx.shadowOffsetY = lightDY * cellDepth;
        roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
        ctx.fillStyle = c.dotFilled;
        ctx.fill();
        ctx.restore();

        // 2) Colored ambient glow, layered on top so the tile also reads as
        //    luminous, not just physically raised.
        ctx.save();
        ctx.shadowColor = hexToRgba(c.dotFilledGlow, c.dotFilledGlowOpacity);
        ctx.shadowBlur = 18;
        roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
        ctx.fillStyle = c.dotFilled;
        ctx.fill();
        ctx.restore();

        // 3) Top-edge highlight stroke on the side facing the light — a thin
        //    bevel that sells the tile as a solid 3D surface, not a flat fill.
        ctx.save();
        roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
        ctx.clip();
        const hlGrad = ctx.createLinearGradient(
          drawX - lightDX * drawSize, drawY - lightDY * drawSize,
          drawX + lightDX * drawSize, drawY + lightDY * drawSize
        );
        hlGrad.addColorStop(0, hexToRgba('#FFFFFF', c.highlightOpacity * 0.5));
        hlGrad.addColorStop(0.35, 'rgba(255,255,255,0)');
        ctx.fillStyle = hlGrad;
        ctx.fillRect(drawX, drawY, drawSize, drawSize);
        ctx.restore();
      } else {
        // Recessed / not-yet cell: darker inset fill plus a faint inner shadow
        // on the light-facing edge, so it reads as a shallow carved-in socket
        // rather than a flat outline — depth without visual weight.
        roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
        ctx.fillStyle = hexToRgba(c.dotUnfilledFill, c.dotUnfilledFillOpacity);
        ctx.fill();

        ctx.save();
        roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
        ctx.clip();
        const insetGrad = ctx.createLinearGradient(
          drawX - lightDX * drawSize, drawY - lightDY * drawSize,
          drawX + lightDX * drawSize, drawY + lightDY * drawSize
        );
        insetGrad.addColorStop(0, hexToRgba(c.shadowColor, c.unfilledRecessOpacity));
        insetGrad.addColorStop(0.3, 'rgba(0,0,0,0)');
        ctx.fillStyle = insetGrad;
        ctx.fillRect(drawX, drawY, drawSize, drawSize);
        ctx.restore();

        ctx.lineWidth = unfilledStrokeWidth;
        roundedRectPath(ctx, drawX, drawY, drawSize, drawSize, drawRadius);
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

  // ---- Progress bar ---------------------------------------------------------

  const percent = filledDots / config.totalDays;
  const barW = gridW * layout.progressBarWidthRatio;
  const barX = width / 2 - barW / 2;
  const barY = gridBottom + layout.footerGap;
  const barH = layout.progressBarHeight;

  if (t.showProgressBar) {
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
  }

  // ---- Footer text: day counter / date range / percentage -------------------

  let footerY = t.showProgressBar ? barY + barH + 26 : gridBottom + layout.footerGap;

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
  const outputName = config.outputName || config.id || 'wallpaper';

  // Stable filename an iOS Shortcut always fetches (overwritten daily).
  await writeFile(path.join(outDir, `${outputName}.png`), buffer);

  // Small JSON status file per tracker, useful for the Shortcut or debugging.
  const status = {
    id: config.id,
    startDate: config.startDate,
    today: todayISO,
    dayNumber: clampedDayNumber,
    totalDays: config.totalDays,
    filledDots,
    complete: isComplete,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(outDir, `${outputName}-status.json`), JSON.stringify(status, null, 2));

  console.log(`[${config.id}] Wrote docs/${outputName}.png (${width}x${height})`);
  console.log(`[${config.id}] Wrote docs/${outputName}-status.json\n`);
}

// ---- Main: loop over all trackers (or just --only=<id>) -----------------------

const todayISO = getTodayISO();
const trackers = onlyId ? rootConfig.trackers.filter((t) => t.id === onlyId) : rootConfig.trackers;

if (trackers.length === 0) {
  console.error(`No tracker found matching id "${onlyId}". Available ids: ${rootConfig.trackers.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

for (const tracker of trackers) {
  await renderTracker(tracker, todayISO);
}
