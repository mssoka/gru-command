# Book of Lessons

The operation's long-term memory: day-to-day journal entries are
distilled by the dream pass into a collated, deduplicated, **concise**
book of lessons. Briefings and directives then carry **pointers** into
it — never the text itself. An agent reads the pointed section on demand
at its location, so context stays small and the memory stays honest.

The mechanism ships with gru-command; the content accrues per user.

## The pipeline

```
deliberate capture          distillation              progressive disclosure
journal/*.jsonl      →      dream (Bob, 12h)     →    bible/INDEX.md (≤1 KB)
  finding | ruling            dedupe + recurred        chapters/*.md (≤4 KB)
  observation                 provenance + caps        pointer lines in briefings
```

### 1. Journal (capture)

Append-only JSONL under `<data_dir>/journal/`, one file per source-day.
Entries are deliberate — nothing writes noise:

- **Gru** appends after incidents and decisions (the judgment trail).
- **Silas** appends ops observations from his sweeps.
- **Minions** may end a delivery report with an optional fenced
  `lessons` block; the host extracts it at settle.
- **The owner** can append through the same API.

`POST /api/journal` with `{kind: 'finding'|'ruling'|'observation',
source: 'gru'|'silas'|'minion:<job>'|'owner', tags: [...], body}`.
`GET /api/journal?after=<seq>&limit=<n>` lists entries back. Both are
behind the pairing token, like every other mutating surface.

```json
{"seq":7,"id":"j-7","ts":"2026-09-23T18:22:31.000Z","kind":"finding","source":"gru","tags":["repo:x","topic:restarts"],"body":"…"}
```

### 2. Dream (distillation)

A cadence job — **on boot + every 12 h** by default (`[lessons]`
`dream_interval_ms`, `dream_on_boot`). Bob reads the journal entries
newer than the last dream, merges repeats into their existing lesson
(`recurred: N`, provenance unioned), rewrites **only the affected
chapters**, and enforces the caps by trimming — never by appending
journal text verbatim. Every lesson cites its journal ids and dates.

The cursor only advances after a successful apply: a failed pass retries
the same entries at the next beat. Nothing new = no distiller call = no
model cost.

### 3. Bible (format)

Under `<data_dir>/bible/`:

- `INDEX.md` — hard cap (~1 KB): chapter list, one-line summaries,
  keyword tags. **The only part ever embedded in briefings.**
- `chapters/<slug>.md` — the chapters, with stable anchors. Each lesson
  is an `## <lesson-slug>` section (that heading **is** the anchor):

  ```md
  ## gru-shell-hang

  recurred: 2
  provenance: j-12@2026-09-23T18:22:31.000Z, j-27@2026-09-24T09:00:00.000Z

  Kill the shell before restarting the service.
  ```

- `README.md` — seeded documentation; `INDEX.md` ships as an empty
  template. The tree is machine-managed: corrections go through the
  journal and the next dream, never by hand.

### 4. Reference (injection)

Gru and Silas match task keywords against the index (v1: deterministic
grep-level matching, no embeddings) and the briefing/directive template
gains an optional section of pointer lines:

```
RELEVANT LESSONS (pointers only — read the section at its path on demand; nothing is inlined):
- read /path/to/bible/chapters/ops-restarts.md#gru-shell-hang (why: task mentions restart, shell)
```

A minion reads the pointed section with its own file tools when the task
needs it. Chapter bodies are **never** inlined into a briefing — a test
pins that. `GET /api/lessons?task=…` renders the same pointers for
callers that want them explicitly.

## Configuration

```toml
[lessons]
enabled = true               # false: no dream cadence, no pointer injection
dream_interval_ms = 43200000 # 12 h; 0 disables the periodic pass
dream_on_boot = true         # one catch-up pass at service boot
chapter_cap_bytes = 4096     # per chapter; the dream trims to fit
index_cap_bytes = 1024       # INDEX.md hard cap — the only embedded part
max_references = 3           # pointer lines per briefing/directive
```

`enabled = false` disables the dream cadence and pointer injection; the
journal API stays available, because capture is deliberate and must
never be lost.

When the index cannot hold every chapter even after compaction, the
dream fails loud (the operator consolidates chapters or raises the cap):
the cap is the pressure that keeps the index worth reading.

## Failure modes (fail loud, never silent)

| Condition | Behavior |
|---|---|
| Malformed journal line | the read throws naming file:line; repair or remove it |
| Distiller cites unknown journal id | the pass fails; cursor unchanged; next beat retries |
| Distiller writes no output file | the pass fails loud; cursor unchanged |
| Chapter over cap | bodies trimmed, least-valuable lessons archived with provenance |
| Index over cap after compaction | the pass fails loud; chapters must consolidate |
| Dream disabled | journal still captures; no dream, no injection |
