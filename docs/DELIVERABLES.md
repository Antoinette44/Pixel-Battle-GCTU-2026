# Deliverables checklist and templates

## 1. Git repository
Source (`server.js`, `public/*`, `tests/`, `tools/`) plus design files (.svg logo / team banners, .psd/.xcf if any).
Commits from **every** member across the weeks. Suggested split for up to 8 members:
server and networking (`server.js`) | rasterizer tools x2 (`raster.js`: lines + circle / polygon + fill) | UI and palette (`index.html`, `style.css`, `palette.js`) |
replay and scoreboard (`app.js`) | testing and load test (`tests/`, `tools/`, phone test sheet) | report, diary, video | presentation and class activity.
Each member must be able to explain **and change live** the part they own.

## 2. Report (4-6 pages)
1. Concept: what Pixel Battle is, the rules (teams, cooldown, limits).
2. How we built it: architecture (client / server / action log), frame buffer, the five algorithms with a worked example each
   (Algorithm lab: Bresenham (2,2)-(12,8), midpoint r = 10, scan-line y = 7), the HSB palette table, cooldown and scoreboard, replay.
3. Screenshots: join screen, all tools, phone view, scoreboard, palette sheet, replay.
4. Tests: `npm test` output; load-test table (players, p50/p95 latency, identical canvases); phone/laptop sheet (device, browser, result).
5. Problems and fixes: e.g. one bucket wiping the canvas -> region limit; double-counted polygon vertices -> half-open edge rule; page scrolling under the finger -> `touch-action: none`.
6. References: Angel & Shreiner ICG 6.8-6.10; Marschner & Shirley FCG 8.1; Guha 14.3-14.4; Week 2 lecture; `ws` docs; MDN (Pointer Events, WebSocket, MediaRecorder).
7. AI-use declaration.

### AI-use declaration (edit to the truth)
> We used <tool> to <e.g. scaffold the project structure and explain how the WebSocket server and client fit together>.
> The course algorithms (Bresenham, midpoint circle, scan-line fill, flood fill, HSB conversion) were studied, re-typed/checked and are understood by the group;
> each member can explain and modify their part. AI-assisted files/functions: ...

The brief says the course algorithms must be **your group's own code**. If you start from this code, declare it, then make it yours:
re-type `raster.js` from the slides, run `npm test`, and trace the Algorithm lab tables by hand.

## 3. Build diary (one entry per week, with screenshots)
```
Week N (date)
- Goal:            - Who did what:
- Built / learned (1-2 screenshots):
- Problems and fixes:
- AI used? (what for, what we changed):
- Next week:
```

## 4. Contribution table (signed by all members)
| Member | Student ID | Work package | Main files / tasks | Signature |
|--------|-----------|--------------|--------------------|-----------|

## 5. 2-minute video script
0:00 title + team | 0:15 join, pick team | 0:30 each tool | 1:00 cooldown, scoreboard, second phone showing live sync |
1:25 palette sheet (H, S, B -> RGB/HEX) | 1:35 time-lapse replay | 1:50 load-test result.

## 6. Presentation / class activity
Teach with worked examples (frame buffer, DDA vs Bresenham, midpoint circle, scan-line + flood fill, HSB), demo every task, then open the public link so the class joins from their phones.
