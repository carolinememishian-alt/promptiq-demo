# PromptIQ — Public Demo

PromptIQ coaches a prompt **before** the model answers: it scores prompt quality,
underlines vague phrases, explains the exact recommended change, and lets you accept
targeted rewrites one phrase at a time. It also shows three prompt skills — Code Review,
Data Analysis, and Marketing Sentiment.

> This is a fully self-contained, **synthetic** demo. It contains **no real people,
> no real organizational data, and no backend** — all analysis runs in the browser.

## Run locally

Any static server works. With Node:

```bash
npx serve .
# or
python3 -m http.server 5600
```

Then open the printed URL (e.g. `http://localhost:5600`).

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | App shell: left nav, chat area, composer. |
| `styles.css` | All styling, including the PromptIQ coaching row and coach card. |
| `app.js` | PromptIQ logic: scoring, classification, term suggestions, rewrites, and UI wiring. |
| `.nojekyll` | Tells GitHub Pages to serve files as-is. |

## Deploy to GitHub Pages

1. Create a new **public** repo on github.com (e.g. `promptiq-demo`).
2. Push these files to the `main` branch:
   ```bash
   git init
   git add -A
   git commit -m "PromptIQ public demo"
   git branch -M main
   git remote add origin https://github.com/<you>/promptiq-demo.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` / `/ (root)`, and save.
4. Your site goes live at `https://<you>.github.io/promptiq-demo/` within a minute.

No build step is required — the demo is plain static HTML/CSS/JS.

## Try it

- Switch skills in the left nav.
- Type `Can you find bugs in my code?` (Code Review) or `Can you analyze this data?`
  (Data Analysis) and click the underlined words for targeted fixes.
- Press **Rewrite** to apply the suggested improvement, or **Use example** to load a
  scenario starter prompt.
