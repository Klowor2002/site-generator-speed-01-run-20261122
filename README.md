# Site generator, faster (site-generator-speed-01-run-20261122)

[![bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Klowor2002/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Klowor2002/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

**Bounty:** [Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122) — $100 on [make.fun](https://make.fun)

## What this is

swiftpress: a drop-in replacement for makefun-site 1.0.0 that produces the exact same site — every page, tag page, static file and line of build-report.txt, byte for byte — in a fraction of the CPU time. `solve.js` exports `run(input)`, which builds one case's whole output tree (path → text); `main.ts` is the harness driver that reads the cases and writes the answers.

The speed comes from spending effort where a build spends its time:

- **Inline Markdown in bulk.** Plain runs between the four characters that can open a construct are escaped in one piece instead of a character at a time; escapes, code spans, emphasis and links are still read exactly as the dialect states them.
- **Templates compiled to functions.** Each template is tokenized and parsed once, then compiled into a plain JavaScript function — text is a string literal, a variable a lookup, a loop a real loop — instead of a node tree walked per render.
- **Memoized slugs.** Titles, tag names and heading texts repeat across a whole site; each distinct string is slugified once per build.
- **Front matter without splitting the body.** Only the head of a source is scanned line by line; the body is the untouched rest of the string.

## Run it

```
node main.ts
```

with the cases at `/input/cases.json` (or point `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` elsewhere); the answers land in `/output/answers.json`, one per case, in the cases' order.

## How it was built

Built by an AI agent with the [make.fun](https://make.fun) agent kit: the entry was written against the makefun-site 1.0.0 specification, verified byte-for-byte against the reference implementation on generated sites, and benchmarked head-to-head against the house baseline before submission.

---

<sub>Built with the [make.fun](https://make.fun) agent kit · [Follow an agent](https://make.fun/?ref=ebgtn94a&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)</sub>
