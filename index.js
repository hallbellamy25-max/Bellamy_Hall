require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const OpenAI = require("openai");
const mongoose = require("mongoose");

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── MongoDB Connection ────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ─── Member Schema ────────────────────────────────────────────────────────────
//
//  Warn / Timeout escalation logic:
//    • Every offence → +1 warn
//    • 3 warns       → timeout (duration scales) + warns reset to 0
//    • 3 timeouts    → permanent ban
//    • warns reset to 0 automatically after WARN_RESET_MS  (30 min) of silence
//    • timeouts reset to 0 automatically after TIMEOUT_RESET_MS (2 h) of good behaviour
//
const memberSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  guildId: { type: String, required: true },
  username: { type: String },

  // ── Last 5 clean messages ──────────────────────────────────────────────────
  lastMessages: {
    type: [
      {
        content: String,
        channelId: String,
        channelName: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },

  // ── Moderation state ───────────────────────────────────────────────────────
  warns: { type: Number, default: 0 }, // current warns (resets after 30 min)
  lastWarnAt: { type: Date, default: null }, // when the last warn was issued
  timeouts: { type: Number, default: 0 }, // lifetime timeout count (resets after 2 h clean)
  lastTimeoutAt: { type: Date, default: null }, // when the last timeout was issued

  // ── Full history (never wiped) ─────────────────────────────────────────────
  badWordHistory: {
    type: [
      {
        content: String,
        channelId: String,
        action: String, // "warn" | "timeout" | "ban"
        timestamp: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },

  joinedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

memberSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const Member = mongoose.model("Member", memberSchema);

// ─── Discord Client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

// ─── Features Toggle ──────────────────────────────────────────────────────────
const features = { badwords: true, logs: true };

// ─── Escalation Config ────────────────────────────────────────────────────────
const WARNS_BEFORE_TIMEOUT = 3; // warns needed to trigger a timeout
const TIMEOUTS_BEFORE_BAN = 3; // timeouts needed to trigger a ban
const WARN_RESET_MS = 30 * 60 * 1000; // 30 minutes
const TIMEOUT_RESET_MS = 2 * 60 * 60 * 1000; // 2 hours

// Timeout durations per offence count (in milliseconds)
// timeout #1 → 5 min, #2 → 30 min, #3 → 2 h
const TIMEOUT_DURATIONS = [
  5 * 60 * 1000, // 1st timeout
  30 * 60 * 1000, // 2nd timeout
  2 * 60 * 60 * 1000, // 3rd timeout (max, triggers ban on next offence)
];

function timeoutDurationFor(timeoutCount) {
  // timeoutCount is the NEW count after incrementing (1-based)
  const idx = Math.min(timeoutCount - 1, TIMEOUT_DURATIONS.length - 1);
  return TIMEOUT_DURATIONS[idx];
}

function msToHuman(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  return `${m}min`;
}

// ─── Bad Word List ────────────────────────────────────────────────────────────
const badWords = [
  "zebi",
  "zeb",
  "زب",
  "zbi",
  "zb",
  "zk",
  "zab",
  "zby",
  "zaby",
  "zeby",
  "3asba",
  "3siba",
  "عصب",
  "97ayba",
  "9o7b",
  "عصبة",
  "3asb",
  "3sb",
  "asba",
  "nik",
  "niq",
  "نيك",
  "3acba",
  "zuk",
  "3ac",
  "niek",
  "nayak",
  "nayk",
  "nyk",
  "neyek",
  "نايك",
  "nayek",
  "naik",
  "manyouk",
  "tnaket",
  "monaka",
  "mounaka",
  "kaboul",
  "nek",
  "sorm",
  "سرم",
  "zok",
  "زك",
  "zokek",
  "omk",
  "أمك",
  "omek",
  "omou",
  "امك",
  "امو",
  "أمو",
  "zabour",
  "زبور",
  "zbar",
  "زبر",
  "9a7ba",
  "قحب",
  "97iba",
  "قحيب",
  "9a7bet",
  "قحبا",
  "97ab",
  "قحاب",
  "9a7boun",
  "قحبون",
  "9a7bt",
  "suck ma dick",
  "mibon",
  "wabna",
  "wapna",
  "wbna",
  "wpna",
  "ميبون",
  "مبن",
  "ميبن",
  "مبون",
  "وبن",
  "miboun",
  "mipoun",
  "mipon",
  "y3aseb",
  "3asabet",
  "termtek",
  "ترم",
  "termtec",
  "termteq",
  "termtk",
  "termtc",
  "termtq",
  "terma",
  "ba3bes",
  "بعبس",
  "kos",
  "كس",
  "بعباس",
  "بعبص",
  "بعباص",
  "ba3bas",
  "bazoul",
  "بزول",
  "بزازل",
  "bzazel",
  "bzoul",
  "bazol",
  "bezoul",
  "bezol",
];
const emojiWords = ["🖕"];

// ─── Text Helpers ─────────────────────────────────────────────────────────────
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function getForwardedContent(message) {
  return message.messageSnapshots
    ? [...message.messageSnapshots.values()]
        .map((s) => s.content?.toLowerCase() || "")
        .join(" ")
    : "";
}

function isBadContent(content) {
  const normalized = normalize(content);
  return (
    badWords.some((w) => normalized.includes(normalize(w))) ||
    emojiWords.some((e) => content.includes(e))
  );
}

// ─── In-memory sliding window (catches bad words split across messages) ───────
const userMessageHistory = new Map();
const HISTORY_WINDOW = 10 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [userId, history] of userMessageHistory.entries()) {
    const recent = history.filter((m) => now - m.time < HISTORY_WINDOW);
    if (recent.length === 0) userMessageHistory.delete(userId);
    else userMessageHistory.set(userId, recent);
  }
}, 60_000);

function getRecentMessages(userId, newMessage) {
  const now = Date.now();
  if (!userMessageHistory.has(userId)) userMessageHistory.set(userId, []);
  const history = userMessageHistory.get(userId);
  const fullContent =
    newMessage.content.toLowerCase() + " " + getForwardedContent(newMessage);
  history.push({ message: newMessage, content: fullContent, time: now });
  const recent = history.filter((m) => now - m.time < HISTORY_WINDOW);
  userMessageHistory.set(userId, recent);
  return recent;
}

function isBadInHistory(userId, currentContent) {
  const combined = normalize(
    (userMessageHistory.get(userId) || []).map((m) => m.content).join(" ")
  );
  return isBadContent(currentContent) || isBadContent(combined);
}

// ─── Logger ───────────────────────────────────────────────────────────────────
const LOG_CHANNEL_NAME = "📊・brew-logs";

function getLogChannel(guild) {
  return (
    guild.channels.cache.find((ch) => ch.name === LOG_CHANNEL_NAME) || null
  );
}

async function sendLog(guild, { color, emoji, title, fields, footer }) {
  const channel = getLogChannel(guild);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji}  ${title}`)
    .addFields(fields)
    .setTimestamp();
  if (footer) embed.setFooter({ text: footer });
  channel.send({ embeds: [embed] }).catch(() => {});
}

function timestamp() {
  return `<t:${Math.floor(Date.now() / 1000)}:T>`;
}

const Colors = {
  badword: "#C0392B",
  warn: "#FEE75C",
  timeout: "#E67E22",
  ban: "#FF0000",
  join: "#57F287",
};

// ─── Core: handle an offence ──────────────────────────────────────────────────
//
//  Returns the action taken: "warn" | "timeout" | "ban"
//
async function handleOffence(message, offendingContent) {
  const { author, guild, channel } = message;
  const now = new Date();

  // Fetch current member doc (or create it)
  let doc = await Member.findOneAndUpdate(
    { userId: author.id, guildId: guild.id },
    { $setOnInsert: { joinedAt: now, updatedAt: now } },
    { upsert: true, new: true }
  );

  // ── Apply time-based resets before doing anything ─────────────────────────

  let { warns, lastWarnAt, timeouts, lastTimeoutAt } = doc;

  // Reset warns if last warn was > 30 min ago
  if (lastWarnAt && now - lastWarnAt > WARN_RESET_MS) {
    warns = 0;
  }

  // Reset timeout count if last timeout was > 2 h ago
  if (lastTimeoutAt && now - lastTimeoutAt > TIMEOUT_RESET_MS) {
    timeouts = 0;
  }

  // ── Increment warn ────────────────────────────────────────────────────────
  warns += 1;

  let action = "warn";
  let timeoutUntil = null;

  if (warns >= WARNS_BEFORE_TIMEOUT) {
    // ── Trigger a timeout ──────────────────────────────────────────────────
    timeouts += 1;

    if (timeouts >= TIMEOUTS_BEFORE_BAN) {
      // ── Ban ───────────────────────────────────────────────────────────────
      action = "ban";
      warns = 0; // doesn't matter but keep clean

      await Member.findOneAndUpdate(
        { userId: author.id, guildId: guild.id },
        {
          $set: {
            warns: 0,
            timeouts,
            lastWarnAt: now,
            lastTimeoutAt: now,
            updatedAt: now,
            username: author.username,
          },
          $push: {
            badWordHistory: {
              $each: [
                {
                  content: offendingContent.slice(0, 500),
                  channelId: channel.id,
                  action: "ban",
                  timestamp: now,
                },
              ],
              $slice: -50,
            },
          },
        }
      );

      // DM before ban
      author
        .send(
          "☕ Coffee Bean: rak tbant. 3 timeouts w mazelt ma tfhemtech. bye."
        )
        .catch(() => {});

      await guild.members
        .ban(author.id, { reason: "3 timeouts — repeated bad word offences" })
        .catch((err) => {
          console.error("Ban failed:", err);
        });
    } else {
      // ── Timeout ───────────────────────────────────────────────────────────
      action = "timeout";
      warns = 0; // reset warns after timeout

      const duration = timeoutDurationFor(timeouts);
      timeoutUntil = new Date(now.getTime() + duration);

      await Member.findOneAndUpdate(
        { userId: author.id, guildId: guild.id },
        {
          $set: {
            warns: 0,
            timeouts,
            lastWarnAt: now,
            lastTimeoutAt: now,
            updatedAt: now,
            username: author.username,
          },
          $push: {
            badWordHistory: {
              $each: [
                {
                  content: offendingContent.slice(0, 500),
                  channelId: channel.id,
                  action: "timeout",
                  timestamp: now,
                },
              ],
              $slice: -50,
            },
          },
        }
      );

      const guildMember = await guild.members
        .fetch(author.id)
        .catch(() => null);
      if (guildMember) {
        await guildMember
          .timeout(duration, "Repeated bad word offences")
          .catch((err) => {
            console.error("Timeout failed:", err);
          });
      }

      // Warn in channel
      const durationStr = msToHuman(duration);
      message.channel
        .send(
          `⏱️ ${author} , 3 warns w mazelt mafhemtech — rak muted **${durationStr}**. (timeout #${timeouts}/3)`
        )
        .then((msg) => setTimeout(() => msg.delete(), 8000));

      // DM the user
      author
        .send(
          `☕ Coffee Bean: rak muted **${durationStr}** 3la 9a7el el klam el zayed.\n` +
            `Timeout #${timeouts}/3 — el jey ykon akbar. barka 3leha.`
        )
        .catch(() => {});
    }
  } else {
    // ── Just a warn ───────────────────────────────────────────────────────────
    await Member.findOneAndUpdate(
      { userId: author.id, guildId: guild.id },
      {
        $set: {
          warns,
          timeouts,
          lastWarnAt: now,
          updatedAt: now,
          username: author.username,
        },
        $push: {
          badWordHistory: {
            $each: [
              {
                content: offendingContent.slice(0, 500),
                channelId: channel.id,
                action: "warn",
                timestamp: now,
              },
            ],
            $slice: -50,
          },
        },
      }
    );

    const warnsLeft = WARNS_BEFORE_TIMEOUT - warns;
    message.channel
      .send(
        `⚠️ ${author} , yezi bla klam zayed ! ` +
          `Warn **${warns}/${WARNS_BEFORE_TIMEOUT}** — ` +
          `${
            warnsLeft === 1
              ? "warn 9adha w rak muted !"
              : `${warnsLeft} warns bachich tmuted.`
          }`
      )
      .then((msg) => setTimeout(() => msg.delete(), 6000));
  }

  return { action, warns, timeouts, timeoutUntil };
}

// ─── DB: track clean message ──────────────────────────────────────────────────
async function trackMessage(message) {
  const { author, guild, channel, content } = message;
  if (!guild) return;
  await Member.findOneAndUpdate(
    { userId: author.id, guildId: guild.id },
    {
      $set: { username: author.username, updatedAt: new Date() },
      $push: {
        lastMessages: {
          $each: [
            {
              content,
              channelId: channel.id,
              channelName: channel.name ?? "unknown",
              timestamp: new Date(),
            },
          ],
          $slice: -5,
        },
      },
      $setOnInsert: { joinedAt: new Date() },
    },
    { upsert: true, new: true }
  );
}

// ─── DB: ensure member exists on join ─────────────────────────────────────────
async function ensureMember(guildMember) {
  await Member.findOneAndUpdate(
    { userId: guildMember.user.id, guildId: guildMember.guild.id },
    {
      $setOnInsert: {
        username: guildMember.user.username,
        lastMessages: [],
        badWordHistory: [],
        warns: 0,
        timeouts: 0,
        joinedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
  console.log(`👤 Member ensured: ${guildMember.user.username}`);
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));

client.on("guildMemberAdd", async (member) => {
  try {
    await ensureMember(member);
  } catch (err) {
    console.error("Error on guildMemberAdd:", err);
  }
});

// ─── Main message handler ─────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const forwardedContent = getForwardedContent(message);
  const allContent = message.content.toLowerCase() + " " + forwardedContent;

  // 1. Bad word detection
  if (features.badwords) {
    const recentMessages = getRecentMessages(message.author.id, message);

    if (isBadInHistory(message.author.id, allContent)) {
      // Delete all recent messages in the window
      recentMessages.forEach((m) => m.message.delete().catch(() => {}));
      userMessageHistory.set(message.author.id, []);

      let result = {
        action: "warn",
        warns: 0,
        timeouts: 0,
        timeoutUntil: null,
      };
      try {
        result = await handleOffence(message, message.content);
      } catch (err) {
        console.error("Error in handleOffence:", err);
      }

      // Log to mod channel
      if (features.logs) {
        const actionEmoji = { warn: "⚠️", timeout: "⏱️", ban: "🔨" }[
          result.action
        ];
        const actionColor = {
          warn: Colors.warn,
          timeout: Colors.timeout,
          ban: Colors.ban,
        }[result.action];
        const actionTitle = {
          warn: "Bad Word — Warning Issued",
          timeout: "Bad Word — Member Timed Out",
          ban: "Bad Word — Member Banned",
        }[result.action];

        const fields = [
          {
            name: "User",
            value: `${message.author} (${message.author.tag})`,
            inline: true,
          },
          { name: "Channel", value: `${message.channel}`, inline: true },
          { name: "Action", value: result.action.toUpperCase(), inline: true },
          {
            name: "Warns",
            value: `${result.warns}/${WARNS_BEFORE_TIMEOUT}`,
            inline: true,
          },
          {
            name: "Timeouts",
            value: `${result.timeouts}/${TIMEOUTS_BEFORE_BAN}`,
            inline: true,
          },
        ];

        if (result.timeoutUntil) {
          fields.push({
            name: "Muted Until",
            value: `<t:${Math.floor(result.timeoutUntil / 1000)}:F>`,
            inline: true,
          });
        }

        fields.push({
          name: "Content",
          value: `\`\`\`${message.content.slice(0, 300)}\`\`\``,
        });
        fields.push({ name: "Time", value: timestamp(), inline: true });

        sendLog(message.guild, {
          color: actionColor,
          emoji: actionEmoji,
          title: actionTitle,
          fields,
          footer: `Warns reset after 30 min • Timeouts reset after 2 h`,
        });
      }

      return;
    }
  }

  // 2. Track clean message
  try {
    await trackMessage(message);
  } catch (err) {
    console.error("Error tracking message:", err);
  }
});

// ─── Edit handler ─────────────────────────────────────────────────────────────
client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (newMessage.author?.bot) return;
  if (!features.badwords || !newMessage.content) return;

  const allContent =
    newMessage.content.toLowerCase() + " " + getForwardedContent(newMessage);

  if (isBadContent(allContent)) {
    newMessage.delete().catch(() => {});

    let result = { action: "warn", warns: 0, timeouts: 0, timeoutUntil: null };
    try {
      result = await handleOffence(newMessage, newMessage.content);
    } catch (err) {
      console.error("Error in handleOffence (edit):", err);
    }

    if (result.action === "warn") {
      newMessage.channel
        .send(
          `${newMessage.author}, fe9t bik ta3mel fi edit — arka7 takel ban rak .`
        )
        .then((msg) => setTimeout(() => msg.delete(), 5000));
    }

    if (features.logs) {
      const actionEmoji = { warn: "⚠️", timeout: "⏱️", ban: "🔨" }[
        result.action
      ];
      const actionColor = {
        warn: Colors.warn,
        timeout: Colors.timeout,
        ban: Colors.ban,
      }[result.action];

      sendLog(newMessage.guild, {
        color: actionColor,
        emoji: actionEmoji,
        title: `Bad Word in Edit — ${result.action.toUpperCase()}`,
        fields: [
          {
            name: "User",
            value: `${newMessage.author} (${newMessage.author.tag})`,
            inline: true,
          },
          { name: "Channel", value: `${newMessage.channel}`, inline: true },
          { name: "Action", value: result.action.toUpperCase(), inline: true },
          {
            name: "Warns",
            value: `${result.warns}/${WARNS_BEFORE_TIMEOUT}`,
            inline: true,
          },
          {
            name: "Timeouts",
            value: `${result.timeouts}/${TIMEOUTS_BEFORE_BAN}`,
            inline: true,
          },
          {
            name: "Edited Content",
            value: `\`\`\`${newMessage.content.slice(0, 300)}\`\`\``,
          },
          { name: "Time", value: timestamp(), inline: true },
        ],
        footer: "Message deleted automatically",
      });
    }
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client
  .login(process.env.TOKEN)
  .catch((err) => console.error("Login error:", err));
