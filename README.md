# ez-telegram

A Telegram group channel for Ez agents. It gives an agent a **second** bot, apart
from the agent's own Telegram chat, to post in a group (or a forum topic per
subject) and to read what members write. It is the Telegram counterpart of
ez-twilio and ez-whatsapp: a managed container long-polls Telegram, keeps a
private journal, and the agent works through one CLI.

Not here: running models, replies without the agent, business workflows, private
chats, channels, files or voice. No content becomes an instruction.

## Set up the bot and the group

1. In BotFather create the bot and copy its token. Use a bot nobody else polls or
   serves with a webhook (never the agent's own Telegram bot).
2. In BotFather turn **Group Privacy** off for it (`/setprivacy` → Disable), or make
   it a group admin; otherwise it sees only commands, mentions and replies.
3. Create the group, add the bot (as an admin for topics: allow *Manage topics* and
   posting), and write one message there. Enabling **Topics** converts a group to a
   supergroup under a new id.
4. `ez telegram chats` shows the group id (a negative number); `ez telegram doctor`
   reports anything blocking.

## Install

```sh
ez plugins inspect telegram --source /absolute/ez-telegram
ez plugins install telegram --source /absolute/ez-telegram --revision sha256:INSPECTED_HASH
ez plugins start telegram
ez telegram init < /private/telegram.json     # {"botToken":"..."}; stdin only
ez telegram doctor --json
```

## Use

```sh
ez telegram chats
ez telegram topic create --chat -1001234567890 --name "12 Example Street" --key thread-lead-1
ez telegram operation --key thread-lead-1                       # providerTopicId
ez telegram send --chat -1001234567890 --topic 901 --text-stdin --key post-lead-1-1 < note.txt
ez telegram inbox --consumer pa --limit 20
ez telegram acknowledge --consumer pa --cursor 17
```

`send` is exactly-once per key: `accepted` means Telegram posted it (there are no read
receipts), `rejected` means nothing was posted, exit 5 `uncertain` means inspect
`operation` and the chat before anything else. `--help` is the argument contract and
`skills/telegram/SKILL.md` the agent's guide.

## Limits

- One profile serves one bot; a different bot needs a separate profile.
- Telegram keeps an unconfirmed update for 24 hours; the journal keeps what the poller
  confirmed. There is no history import, backup export or wake event yet: the agent
  reads `inbox` on its own schedule.
- Groups and supergroups only. A group that migrates to a supergroup continues under a
  new id (`chats` shows `migratedTo`).

## Develop

```sh
pnpm verify   # offline tests against a Bot API stand-in over real HTTP
docker build --target test .
```

MIT licensed. Independent of Telegram.
