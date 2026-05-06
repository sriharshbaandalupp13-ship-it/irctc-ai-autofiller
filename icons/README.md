# Icons Needed

Create PNG icons for the Chrome extension in these sizes and place them in this folder:

- `16.png`
- `32.png`
- `48.png`
- `128.png`

Suggested design:

- Background: IRCTC blue `#1A237E`
- Accent: orange ticket or lightning motif in `#FF6D00`
- Symbol idea: a train seat or cursor filling a form
- Keep the shape simple so it stays legible at `16x16`

If you add these files later, you can update `manifest.json` to include:

```json
"icons": {
  "16": "icons/16.png",
  "32": "icons/32.png",
  "48": "icons/48.png",
  "128": "icons/128.png"
}
```
