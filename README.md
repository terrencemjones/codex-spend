# claude-spend

See where your Codex tokens go. One command, zero setup.

## Install

```bash
npx claude-spend
```

Opens a local dashboard in your browser.

## What It Does

- Reads your local Codex session files from `~/.codex/` (nothing leaves your machine)
- Shows token usage per conversation, per day, and per model
- Surfaces insights and your most expensive prompts

## Options

```bash
claude-spend --port 8080   # custom port (default: 3456)
claude-spend --no-open     # do not auto-open browser
```

## Privacy

All data stays local. `claude-spend` reads from your local `~/.codex/` directory and serves a dashboard on `localhost`.

## License

MIT
