# ez-telegram

Independent Telegram group CLI plugin: one managed container long-polls the Bot API,
keeps a private SQLite journal and send receipts, and exposes `ez telegram`. Read
README.md and skills/telegram/SKILL.md.

No relay imports, agent/model calls, core-channel Telegram code, business workflows or
database. Provider mechanics live here; the agent owns decisions. `accepted` proves
Telegram posted a message, not that anyone read it. Preserve uncertainty and stable
operation keys. The bot token enters only through private stdin and never appears in
output, errors or logs. Tests use a Bot API stand-in over real HTTP; real sends need an
explicitly identified group. Keep private profiles outside this repo.
