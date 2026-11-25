# Scriptable scripts

Scripts for [Scriptable](https://scriptable.app), the JavaScript automation app for iOS.

## tb — Timebutler

`tb.js` drives [Timebutler](https://www.timebutler.com) time tracking and absences from the iPhone through the [REST API v2](https://app.timebutler.com/api/v2/docs) with a personal access token.

### Setup

1. Copy `tb.js` into Scriptable as a script named `tb` (via the iCloud Drive Scriptable folder, AirDrop, or by pasting it into a new script).
2. Create a personal access token on the API docs page ("Create or revoke a personal token").
3. Run `tb` once in the app and paste the token. It is stored in the iOS Keychain, never in the script.

### Ways to run it

- **In the app:** a menu that shows the clock state and offers the matching actions (start, pause, resume, stop and save, discard), plus logging entries, the entries list, vacation balance, absence requests, the absence list (tap one to cancel it), `.ics` export, lookup lists and the profile. Every write asks for confirmation first.
- **As a widget:** clock state, a live timer while the clock runs, and today's worked time against the target. The medium size adds the vacation days left. Tapping it opens the menu.
- **From Shortcuts, Siri or a URL:** pass a command and its options, for example `scriptable:///run/tb?cmd=start`, or a Shortcuts dictionary such as `{cmd: "stop", message: "release", yes: true}`. A plain text parameter like `status` works too.
    - Outside the app no dialog can be shown, so writes need `yes: true`.
    - `json: true` returns the raw API data instead of text.

### Commands

| Command | Options |
|---|---|
| `status`, `start`, `pause`, `resume`, `cancel` | |
| `stop` | `project`, `category`, `message`, `break` (`apply` or `ignore`) |
| `log` | `date`, `time` (`09:00-17:30`), `pause` (`30m`, `1h15m`), `project`, `category`, `message`, `dryRun`; or `entries` (a list of `{date, time, pause, project, category, remarks}`) with top-level `project`, `category`, `pause` as defaults |
| `entries` | `month` (`YYYY-MM`, or `YYYY` for a whole year) |
| `balance`, `whoami` | |
| `off` | `start`, `end`, `type` (code or name, default `VAC`), `half` (`morning` or `afternoon`), `sub`, `message`, `hours` (overtime types `UEB`/`AUA` only) |
| `absences` | `upcoming`, `editing` |
| `absence-cancel` | `id`, `reason` |
| `ics` | `pending` |
| `projects`, `categories`, `absence-types`, `subs` | `refresh` |

### Behaviour

- Projects, categories, absence types and substitutes accept an ID or a name: exact, then unique prefix, then unique substring, then unique in-order letters (`cprt` matches CustomerPortal). An ambiguous name is an error listing the candidates; `none` sends no assignment. In the app, pickers replace the names.
- Without a project or category the company default is used; a mandatory one without a default fails before anything is sent.
- Times are Europe/Berlin wall-clock time whatever the phone's time zone, converted correctly across daylight-saving changes. Start and end of an entry must be on the same day.
- When stopping breaks the company's break rule, the correction is shown and you choose to apply or ignore it; backing out leaves the clock running.
- A `429` response is retried once after `Retry-After`. Lookups are cached for an hour.
- `.ics` events have stable UIDs, so re-importing updates events instead of duplicating them.

### Tests

The pure functions and the command flows run in Node against a fake transport, no dependencies needed:

```sh
npm test
```

## Contributing

Commits must use a GitHub noreply address and pass [gitleaks](https://github.com/gitleaks/gitleaks). Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

## License

MIT
