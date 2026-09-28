# Chakwal DC Rate Calculator — standalone web project

Plain HTML, CSS and JavaScript. No build step, no framework, no server. Open
`index.html` and it runs.

```
index.html                  the form
styles.css                  styling, copied from the main project unchanged
app.js                      all logic: the cascade, the conversions, the DC value
data/reference.js           rural place names, bundled
data/urban.js               urban place names, bundled
data/khasras/<mouzaId>.js   that mouza's Khasra numbers, bundled (226 files, 6.0 MB)
```

## What it does, and the one thing it cannot do

The form is the real one, with both chains from the main app — **Rural** and
**Urban** — and the Qanoongoee filling itself in from the Mouza pick.

**Rural:** Qanoongoee → Mouza → land classification → Location → Khasra. All 226
mouzas, 8 Qanoongoes and 526 classification/location lists are bundled, so every
dropdown is populated with no network at all. Every Khasra the portal publishes
for the tehsil is bundled too — 908,221 numbers across 226 files, loaded on
demand one mouza at a time. So the list is always complete: nothing to page
through, nothing to fetch, and the page itself stays small because only the mouza
you pick is ever pulled in.

**Urban:** Town / City → Revenue Circle → Floor → Property Area. 2 towns, 10
revenue circles, 118 property areas, 5 floors, all bundled.

**The urban chain stops at the Property Area, and that is the portal's doing,
not this tool's.** Every one of the 118 property areas was checked and every one
reports `hasKhasra: false, hasSquare: false` and publishes no land
classification — so there is no Location list to choose from and no narrower
parcel to pick. The page says so in a notice on the Urban tab and again on the
property area itself. Rural data is complete and unaffected.

The unit conversion and the DC value arithmetic are complete and exact. You type
the rate and the page values the land.

**It cannot read the rate from the Punjab e-Stamp portal.** That is the one
limitation, and it is a browser rule rather than something this code can work
around. The portal replies with no `access-control-*` headers at all, so when a
page on any domain asks it for data, the browser throws the reply away before any
script here gets to see it. Verified directly: a successful rate request sent
with an `Origin` header returns ten headers, none of them CORS.

The FastAPI project in the parent folder fetches the rate server-side and does
the identical arithmetic. If you want live rates, run that instead, or deploy the
`deploy/` EdgeOne package so the server runs off your PC.

## Selecting many Khasras at once

Under the Khasra box there is a **Select many Khasras…** button. It opens the
full published list for the chosen Mouza, classification and Location, in
ascending order. Click a number to toggle it, hold <kbd>Shift</kbd> and click a
second number to sweep everything between the two, type in the filter box to
narrow the list, or hit **Select all matching** to take the lot at once.

The anchor stays put across repeated Shift-clicks, so a sweep can be widened
and narrowed from a fixed origin, and Shift-clicking a fully-selected block
takes it all back off again.

**Value selected** then applies the single rate you typed to every Khasra you
picked, shows the whole set as a table, and offers it as CSV.

### Read this before trusting the bulk table

That is a real calculation, but it is **not** the official rate for each Khasra.
Khasras inside one mouza are frequently rated differently from one another —
agricultural, residential and commercial land in the same location rarely share
a figure. This build has no portal connection, so it cannot look each one up
separately the way the server build does. Treat the table as *"what these 8,768
would be worth at Rs. 6,146 per Marla"*, not as their individual rates. The
result card says this underneath the table.

## The arithmetic is verified, not assumed

`convert()` and `landValue()` in `app.js` are ports of `to_marla()`,
`convert_area()` and `land_value()` in `govapi.py`. They were checked against
each other across 10 cases — every unit pairing, both Marla sizes, all three
Acre-to-Kanal settings, per-Acre rates alongside per-Marla ones — comparing all
four output quantities each time. **40 of 40 comparisons identical**, including
the awkward cases like 3.5 Kanal priced per Acre, which lands on
4408.928571428572 in both.

The case that matters most is a rate quoted per **Acre** rather than per Marla.
Rural agricultural Khasras usually are. At 1 Acre and Rs. 100,000/Acre the
answer is Rs. 100,000. Treating the rate as per-Marla instead would give
Rs. 16,000,000 — a factor of 160. The result card says so, and the form asks
for the rate's unit separately from the area's unit so the two cannot be
confused.

## No rate is stored anywhere

`data/reference.js` holds place names and nothing else. `data/khasras/` holds
Khasra numbers and nothing else. Every rate is read live from the portal on each
lookup. That is deliberate: a saved rate quietly goes stale, and a stale rate is
worse than no answer at all, because someone may pay a property fee calculated on
it.

Khasra numbers are bundled on a different reasoning, and it is worth being clear
about the difference. A rate is a value that changes and has legal weight. A
Khasra number is an identifier — it exists or it does not, and a new one only
ever gets added. So the bundled list cannot go quietly out of date in the way a
bundled rate would. If the portal ever adds a Khasra, the bundled list is simply
missing it, and the single-number box above is still typed and still works.

## Reference data

Bundled by walking the portal's own lists on the date shown in the page footer —
41 districts, 226 mouzas, 526 classification/location lists, and 908,221 Khasra
numbers in 1,066 location lists — taken at bounded concurrency so the government
server is not hammered. It goes stale if the portal adds mouzas; refresh it by
re-running the export against a running instance of the main project.

## Verified in a browser

226 mouzas listed, search narrowing correctly, Qanoongoee auto-filling from the
Mouza and never disagreeing, classification → Location cascade, per-Marla result
of Rs. 6,146 for Khasra 1 of Padshahan, the per-Acre case above, all four
validation guards reporting, reset clearing state, no layout overflow, and no
console errors.

**Rural / Urban switch:** both halves present, the inactive one hidden, and
switching clears the other half's picks so an urban parcel can never be valued
against a rural classification. Urban cascade walked end to end — Town
(Municipal Committee Chakwal City) → Revenue Circle (Chakwal) → Floor (Ground
Floor) → Property Area (Anarkali Bazar…) — with the Property Area level message
appearing only once a property area is actually chosen. The second town (Tehsil
Council Chakwal → Mureed) works too. Urban valuation at 1,000 sq ft and
Rs. 45,000/sq ft returned exactly **Rs. 45,000,000**, implied Rs. 45,000/sq ft.

**Batch table sorting:** clicking a header sorts, clicking again reverses. Khasra
sorts numerically, so `20` comes before `1998`, `1000` before `10000`, and
subdivided numbers sit beside their parents — `1807`, `1807/1`, `1807/55` — rather
than at the end. Headers are keyboard-reachable and respond to Enter and Space.
CSV deliberately stays in ascending Khasra order regardless of how the table is
sorted, so an export is reproducible.

The multi-Khasra picker was checked against the largest list in the tehsil —
Padshahan / Residential / Link Road, **8,768 Khasras** in one location:

- all 8,768 rendered, ascending, subdivided numbers (`1807/1`, `8777`) sitting
  next to their parents rather than at the end
- 8,768 datalist suggestions on the single-Khasra box
- single click toggles; Shift-click swept 1–10; a second Shift-click took all 10
  back off
- filter `18` narrowed 8,768 → 277, and clearing it restored all 8,768 with the
  selection preserved
- Select all matching took all 8,768
- **Value selected** produced 8,768 table rows and 8,768 CSV lines, rendered in
  about 1.2 s, no horizontal overflow, no console errors

The CSV carries fifteen columns per Khasra: number, district, tehsil, Qanoongoee,
mouza, classification, location, area and its unit, the area converted into rate
units, the rate and its unit, the DC value, total sq ft, and the implied rate
per sq ft.

Three bugs were found and fixed while testing this: a missing rate was being
swallowed by the browser's own validation bubble, leaving the status line blank
with no explanation; choosing a Qanoongoee while a search was active silently cut
the Mouza list from 19 entries to 1 with nothing saying why; and the Khasra
datalist was never populated because its element reference was missing from the
DOM refs. All three now report themselves.

### Why the Khasra files load as `<script>`, not `fetch()`

Because `fetch()` of a local file is blocked under `file://` — which is exactly
how this project is meant to be opened. Each file is a `<script>` that assigns
`window.KH_<mouzaId>`, so the same files work from a hard drive and from a web
server alike. The payload is namespaced to `window.KH_*` rather than dropped
loose on `window`.

