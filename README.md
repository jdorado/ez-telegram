# ez-telegram

A Telegram group channel for Ez agents. It gives an agent a **second** bot, apart
from the agent's own Telegram chat, to post in a group (or a forum topic per
subject) and to read what members write. Connected to the agent as an Ez
application channel, a message in a group wakes the agent at once. It is the Telegram counterpart of
ez-twilio and ez-whatsapp: a managed container long-polls Telegram, keeps a
private journal, and the agent works through one CLI.

Not here: running models, replies without the agent, business workflows, private
chats from users not allowed, channels, video.

## Set up the bot and the group

1. In BotFather create the bot and copy its token. Use a bot nobody else polls or
   serves with a webhook (never the agent's own Telegram bot).
2. In BotFather turn **Group Privacy** off for it (`/setprivacy` → Disable), or make
   it a group admin; otherwise it sees only commands, mentions and replies.
3. Create the group, add the bot (as an admin for topics: allow *Manage topics* and
   posting, plus *Pin messages* for `pin` and *Delete messages* for deleting others' messages), and write one message there. Enabling **Topics** converts a group to a
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
ez telegram topic rename --chat -1001234567890 --topic 901 --name "🔴 Today 2pm · 12 Example Street" --key name-lead-1-1
ez telegram send --chat -1001234567890 --topic 901 --text-stdin --key post-lead-1-1 < note.txt
ez telegram send --chat -1001234567890 --topic 901 --html --text "<b>CALL 555-0100 · CODE 12</b>" --key post-lead-1-2
ez telegram pin --send-key post-lead-1-1 --key pin-lead-1      # top of topic 901, silent
ez telegram delete --send-key post-lead-1-1 --key delete-lead-1-1 # within 48 hours of posting
ez telegram inbox --consumer pa --limit 20
ez telegram acknowledge --consumer pa --cursor 17
```

`send` posts plain text, or Telegram HTML with `--html`. It is exactly-once per key: `accepted` means Telegram posted it (there are no read
receipts), `rejected` means nothing was posted, exit 5 `uncertain` means inspect
`operation` and the chat before anything else. `--help` is the argument contract and
`skills/telegram/SKILL.md` the agent's guide.

## Wake the agent (Ez application channel)

Like ez-slack, the plugin can be bound to the agent as an Ez application channel.
The operator registers a binding inside the relay (`ezenciel-agents-application --id
telegram --token-file /private/token`), puts the plugin and the relay's application
listener on one private network (the agent's host-executor network binding pins the
inspected plugin revision), and passes the binding privately:

```sh
ez telegram connect < /private/ez-connection.json   # {"url":"http://relay:8787","token":"...","privateHttp":true}
```

From then on every human message in a group the bot is in starts an ordinary run of
the agent at once (messages captured before `connect` are not replayed). Each forum
topic is its own scope (`telegram:CHAT:TOPIC`, or `telegram:CHAT:main`), so its own
continuing conversation. Whatever the agent sends in that run is posted back into the
topic as a reply to the message, once per message key. **Adding the bot to a group
trusts every member there with the agent's owner authority**: use dedicated groups
and add the bot only where that is intended. `status` shows `channel` progress
(admitted cursor, open runs, last pass).

To deliver scheduled text replies, add `"scheduledReplies":true` to the
private connection JSON. The plugin reads the most recent 100 runs from that
Ez application binding. Only schedules bound to this channel can deliver.
Private chats and their topics require the recipient on the DM allowlist. Scheduled sends use
the same durable operation receipts as chat replies and post without a reply-to
message. Check `status` for the latest sweep and `operation` for provider delivery.

## Files, voice and direct messages

- **Photos and documents** (up to 10 MB) in a message are attached to the agent's run
  (Ez stages them for the agent to open); larger files arrive as a note.
- **Voice notes and audio** arrive as their transcript. **`send --voice`** posts the text
  as a voice note in the configured voice. Both use ElevenLabs (speech-to-text
  `scribe_v1`; text-to-speech straight to Ogg Opus, Telegram's voice format), set up once
  by the operator: `ez telegram voice-init < /private/voice.json` with
  `{"elevenlabsApiKey","voiceId","model"?}`.
- **Direct messages** to the bot are ignored, except from user ids the operator allows
  (`ez telegram dms --allow USER_ID`, `--remove`); an allowed user's DM is its own
  conversation (`telegram:USER_ID:main`) and replies go back to that DM.
  Use `"directMessagesOnly":true` in the private connection JSON to keep groups
  from starting runs or receiving scheduled replies on this binding.

## Limits

- One profile serves one bot; a different bot needs a separate profile.
- Telegram keeps an unconfirmed update for 24 hours; the journal keeps what the poller
  confirmed. There is no history import or backup export. Without `connect` the agent reads
  `inbox` on its own schedule.
- Groups and supergroups only. A group that migrates to a supergroup continues under a
  new id (`chats` shows `migratedTo`).

## Develop

```sh
pnpm verify   # offline tests against a Bot API stand-in over real HTTP
docker build --target test .
```

MIT licensed. Independent of Telegram.
