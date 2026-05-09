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

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEMA: GuildConfig
//  One document per guild — stores allowed channels & exempt roles
// ══════════════════════════════════════════════════════════════════════════════
const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // Channel IDs the bot actively reads & moderates.
  // Empty array = bot works in ALL channels (default behaviour).
  allowedChannels: { type: [String], default: [] },

  // Role IDs that are completely exempt from bad-word detection / warns.
  // Add admin / mod / owner roles here.
  exemptRoles: { type: [String], default: [] },

  updatedAt: { type: Date, default: Date.now },
});
const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

// In-memory cache so we don't hit MongoDB on every single message
const configCache = new Map(); // guildId → { allowedChannels: Set, exemptRoles: Set }

async function getConfig(guildId) {
  if (configCache.has(guildId)) return configCache.get(guildId);

  let doc = await GuildConfig.findOne({ guildId });
  if (!doc) doc = await GuildConfig.create({ guildId });

  const cfg = {
    allowedChannels: new Set(doc.allowedChannels),
    exemptRoles:     new Set(doc.exemptRoles),
  };
  configCache.set(guildId, cfg);
  return cfg;
}

function invalidateCache(guildId) {
  configCache.delete(guildId);
}

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEMA: Member
// ══════════════════════════════════════════════════════════════════════════════
const memberSchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  guildId:  { type: String, required: true },
  username: { type: String },

  lastMessages: {
    type: [{
      content:     String,
      channelId:   String,
      channelName: String,
      timestamp:   { type: Date, default: Date.now },
    }],
    default: [],
  },

  warns:         { type: Number, default: 0 },
  lastWarnAt:    { type: Date,   default: null },
  timeouts:      { type: Number, default: 0 },
  lastTimeoutAt: { type: Date,   default: null },

  badWordHistory: {
    type: [{
      content:   String,
      channelId: String,
      action:    String,
      timestamp: { type: Date, default: Date.now },
    }],
    default: [],
  },

  joinedAt:  { type: Date, default: Date.now },
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

// ─── Features ─────────────────────────────────────────────────────────────────
const features = { badwords: true, logs: true };

// ─── Escalation Config ────────────────────────────────────────────────────────
const WARNS_BEFORE_TIMEOUT = 3;
const TIMEOUTS_BEFORE_BAN  = 3;
const WARN_RESET_MS        = 30 * 60 * 1000;
const TIMEOUT_RESET_MS     = 2  * 60 * 60 * 1000;
const TIMEOUT_DURATIONS    = [
  5  * 60 * 1000,
  30 * 60 * 1000,
  2  * 60 * 60 * 1000,
];

function timeoutDurationFor(n) {
  return TIMEOUT_DURATIONS[Math.min(n - 1, TIMEOUT_DURATIONS.length - 1)];
}
function msToHuman(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  return `${m}min`;
}

// ─── Bad Word List ────────────────────────────────────────────────────────────
const badWords = [
  "zebi","zeb","زب","zbi","zb","zk","zab","zby","zaby","zeby",
  "3asba","3siba","عصب","97ayba","9o7b","عصبة","3asb","3sb","asba",
  "nik","niq","نيك","3acba","zuk","3ac","niek","nayak","nayk","nyk",
  "neyek","نايك","nayek","naik","manyouk","tnaket","monaka","mounaka",
  "kaboul","nek","sorm","سرم","zok","زك","zokek","omk","أمك","omek",
  "omou","امك","امو","أمو","zabour","زبور","zbar","زبر","9a7ba","قحب",
  "97iba","قحيب","9a7bet","قحبا","97ab","قحاب","9a7boun","قحبون","9a7bt",
  "suck ma dick","mibon","wabna","wapna","wbna","wpna","ميبون","مبن",
  "ميبن","مبون","وبن","miboun","mipoun","mipon","y3aseb","3asabet",
  "termtek","ترم","termtec","termteq","termtk","termtc","termtq","terma",
  "ba3bes","بعبس","kos","كس","بعباس","بعبص","بعباص","ba3bas","bazoul",
  "بزول","بزازل","bzazel","bzoul","bazol","bezoul","bezol",
];
const emojiWords = ["🖕"];

// ─── Text Helpers ─────────────────────────────────────────────────────────────
function normalize(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]/g, "")
    .replace(/(.)\1+/g, "$1");
}
function getForwardedContent(message) {
  return message.messageSnapshots
    ? [...message.messageSnapshots.values()].map((s) => s.content?.toLowerCase() || "").join(" ")
    : "";
}
function isBadContent(content) {
  const n = normalize(content);
  return badWords.some((w) => n.includes(normalize(w))) || emojiWords.some((e) => content.includes(e));
}

// ─── Sliding window (split-message detection) ─────────────────────────────────
const userMessageHistory = new Map();
const HISTORY_WINDOW = 10_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, hist] of userMessageHistory.entries()) {
    const recent = hist.filter((m) => now - m.time < HISTORY_WINDOW);
    if (!recent.length) userMessageHistory.delete(id);
    else userMessageHistory.set(id, recent);
  }
}, 60_000);

function getRecentMessages(userId, msg) {
  const now  = Date.now();
  const hist = userMessageHistory.get(userId) ?? [];
  hist.push({ message: msg, content: msg.content.toLowerCase() + " " + getForwardedContent(msg), time: now });
  const recent = hist.filter((m) => now - m.time < HISTORY_WINDOW);
  userMessageHistory.set(userId, recent);
  return recent;
}
function isBadInHistory(userId, content) {
  const combined = normalize((userMessageHistory.get(userId) ?? []).map((m) => m.content).join(" "));
  return isBadContent(content) || isBadContent(combined);
}

// ─── Logger ───────────────────────────────────────────────────────────────────
const LOG_CHANNEL_NAME = "📊・brew-logs";

function getLogChannel(guild) {
  return guild.channels.cache.find((ch) => ch.name === LOG_CHANNEL_NAME) ?? null;
}
async function sendLog(guild, { color, emoji, title, fields, footer }) {
  const ch = getLogChannel(guild);
  if (!ch) return;
  const embed = new EmbedBuilder().setColor(color).setTitle(`${emoji}  ${title}`).addFields(fields).setTimestamp();
  if (footer) embed.setFooter({ text: footer });
  ch.send({ embeds: [embed] }).catch(() => {});
}
function timestamp() { return `<t:${Math.floor(Date.now() / 1000)}:T>`; }

const Colors = { warn: "#FEE75C", timeout: "#E67E22", ban: "#FF0000", info: "#5865F2", ok: "#57F287", error: "#ED4245" };

// ══════════════════════════════════════════════════════════════════════════════
//  !config command — manage allowed channels & exempt roles
//
//  Usage (must have Manage Guild permission):
//
//    !config channel add #channel-name   — add a channel to the allowed list
//    !config channel remove #channel     — remove it
//    !config channel list                — show all allowed channels
//    !config channel clear               — allow all channels again
//
//    !config role add @RoleName          — add an exempt role
//    !config role remove @RoleName       — remove an exempt role
//    !config role list                   — show all exempt roles
//    !config role clear                  — clear all exempt roles
//
//    !config show                        — show full current config
// ══════════════════════════════════════════════════════════════════════════════

const CONFIG_HELP =
  "**!config commands:**\n" +
  "`!config channel add #channel` — bot will only watch listed channels (empty = all)\n" +
  "`!config channel remove #channel` — stop watching a channel\n" +
  "`!config channel list` — show watched channels\n" +
  "`!config channel clear` — watch all channels again\n\n" +
  "`!config role add @role` — exempt a role from warns\n" +
  "`!config role remove @role` — remove exemption\n" +
  "`!config role list` — show exempt roles\n" +
  "`!config role clear` — clear all exemptions\n\n" +
  "`!config show` — show everything";

async function handleConfig(message, args) {
  // Require Manage Guild permission
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return message.reply("ma3andekch permission .").then((m) => setTimeout(() => m.delete(), 4000));
  }

  const sub    = args[0]?.toLowerCase(); // "channel" | "role" | "show"
  const action = args[1]?.toLowerCase(); // "add" | "remove" | "list" | "clear"
  const guildId = message.guild.id;

  // ── !config show ────────────────────────────────────────────────────────────
  if (sub === "show" || !sub) {
    const doc = await GuildConfig.findOne({ guildId }) ?? { allowedChannels: [], exemptRoles: [] };

    const chList = doc.allowedChannels.length
      ? doc.allowedChannels.map((id) => `<#${id}>`).join(", ")
      : "All channels (no restriction)";

    const roleList = doc.exemptRoles.length
      ? doc.exemptRoles.map((id) => `<@&${id}>`).join(", ")
      : "None";

    // Also list every channel and role in the server for reference
    const allChannels = message.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText)
      .map((c) => `${c.name} — \`${c.id}\``)
      .join("\n") || "none";

    const allRoles = message.guild.roles.cache
      .filter((r) => !r.managed && r.id !== message.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `${r.name} — \`${r.id}\``)
      .join("\n") || "none";

    const embed = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("⚙️  Bot Configuration")
      .addFields(
        { name: "✅ Allowed channels (bot active in)", value: chList },
        { name: "🛡️ Exempt roles (no warns)", value: roleList },
        { name: "📋 All text channels in this server", value: allChannels.slice(0, 1020) },
        { name: "🏷️ All roles in this server", value: allRoles.slice(0, 1020) },
      )
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  // ── !config channel ─────────────────────────────────────────────────────────
  if (sub === "channel") {
    if (action === "list") {
      const doc = await GuildConfig.findOne({ guildId }) ?? { allowedChannels: [] };
      const list = doc.allowedChannels.length
        ? doc.allowedChannels.map((id) => `<#${id}>`).join(", ")
        : "No restriction — bot is active in all channels.";
      return message.reply(`📋 Allowed channels: ${list}`);
    }

    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { allowedChannels: [], updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply("✅ Channel restriction cleared — bot is now active in all channels.");
    }

    const targetChannel = message.mentions.channels.first();
    if (!targetChannel) {
      return message.reply("Mentionni el channel. ex: `!config channel add #general`").then((m) => setTimeout(() => m.delete(), 5000));
    }

    if (action === "add") {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $addToSet: { allowedChannels: targetChannel.id }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      invalidateCache(guildId);
      return message.reply(`✅ <#${targetChannel.id}> added to allowed channels.`);
    }

    if (action === "remove") {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $pull: { allowedChannels: targetChannel.id }, $set: { updatedAt: new Date() } }
      );
      invalidateCache(guildId);
      return message.reply(`✅ <#${targetChannel.id}> removed from allowed channels.`);
    }

    return message.reply(CONFIG_HELP);
  }

  // ── !config role ─────────────────────────────────────────────────────────────
  if (sub === "role") {
    if (action === "list") {
      const doc = await GuildConfig.findOne({ guildId }) ?? { exemptRoles: [] };
      const list = doc.exemptRoles.length
        ? doc.exemptRoles.map((id) => `<@&${id}>`).join(", ")
        : "No roles are exempt.";
      return message.reply(`🛡️ Exempt roles: ${list}`);
    }

    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { exemptRoles: [], updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply("✅ All role exemptions cleared.");
    }

    const targetRole = message.mentions.roles.first();
    if (!targetRole) {
      return message.reply("Mentionni el role. ex: `!config role add @Admin`").then((m) => setTimeout(() => m.delete(), 5000));
    }

    if (action === "add") {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $addToSet: { exemptRoles: targetRole.id }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> is now exempt from warns.`);
    }

    if (action === "remove") {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $pull: { exemptRoles: targetRole.id }, $set: { updatedAt: new Date() } }
      );
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> is no longer exempt.`);
    }

    return message.reply(CONFIG_HELP);
  }

  return message.reply(CONFIG_HELP);
}

// ─── Offence handler ──────────────────────────────────────────────────────────
async function handleOffence(message, offendingContent) {
  const { author, guild, channel } = message;
  const now = new Date();

  let doc = await Member.findOneAndUpdate(
    { userId: author.id, guildId: guild.id },
    { $setOnInsert: { joinedAt: now, updatedAt: now } },
    { upsert: true, new: true }
  );

  let { warns, lastWarnAt, timeouts, lastTimeoutAt } = doc;
  if (lastWarnAt   && (now - lastWarnAt)   > WARN_RESET_MS)    warns    = 0;
  if (lastTimeoutAt && (now - lastTimeoutAt) > TIMEOUT_RESET_MS) timeouts = 0;

  warns += 1;
  let action = "warn", timeoutUntil = null;

  if (warns >= WARNS_BEFORE_TIMEOUT) {
    timeouts += 1;

    if (timeouts >= TIMEOUTS_BEFORE_BAN) {
      action = "ban";
      warns  = 0;
      await Member.findOneAndUpdate(
        { userId: author.id, guildId: guild.id },
        {
          $set:  { warns: 0, timeouts, lastWarnAt: now, lastTimeoutAt: now, updatedAt: now, username: author.username },
          $push: { badWordHistory: { $each: [{ content: offendingContent.slice(0, 500), channelId: channel.id, action: "ban", timestamp: now }], $slice: -50 } },
        }
      );
      author.send("koul ban . 3 timeouts w mazelt ma fhemtech ro7ek . bye.").catch(() => {});
      await guild.members.ban(author.id, { reason: "3 timeouts — repeated bad word offences" }).catch(console.error);

    } else {
      action = "timeout";
      warns  = 0;
      const duration = timeoutDurationFor(timeouts);
      timeoutUntil   = new Date(now.getTime() + duration);

      await Member.findOneAndUpdate(
        { userId: author.id, guildId: guild.id },
        {
          $set:  { warns: 0, timeouts, lastWarnAt: now, lastTimeoutAt: now, updatedAt: now, username: author.username },
          $push: { badWordHistory: { $each: [{ content: offendingContent.slice(0, 500), channelId: channel.id, action: "timeout", timestamp: now }], $slice: -50 } },
        }
      );

      const guildMember = await guild.members.fetch(author.id).catch(() => null);
      if (guildMember) await guildMember.timeout(duration, "Repeated bad word offences").catch(console.error);

      const durationStr = msToHuman(duration);
      message.channel
        .send(`⏱️ ${author} , 3 warns w mazelt mafhemtech — get muted **${durationStr}**. (timeout #${timeouts}/3)`)
        .then((m) => setTimeout(() => m.delete(), 8000));
      author.send(
        ` koul mute **${durationStr}** 5atrek kathart mel lklam el zayed.\n` +
        `Timeout #${timeouts}/3 — el jey ykoun akbar. yezzi bla klam zayed 5irlek .`
      ).catch(() => {});
    }

  } else {
    await Member.findOneAndUpdate(
      { userId: author.id, guildId: guild.id },
      {
        $set:  { warns, timeouts, lastWarnAt: now, updatedAt: now, username: author.username },
        $push: { badWordHistory: { $each: [{ content: offendingContent.slice(0, 500), channelId: channel.id, action: "warn", timestamp: now }], $slice: -50 } },
      }
    );
    const left = WARNS_BEFORE_TIMEOUT - warns;
    message.channel
      .send(
        `⚠️ ${author} , yezi bla klam zayed ! Warn **${warns}/${WARNS_BEFORE_TIMEOUT}** — ` +
        `${left === 1 ? "warn 9adha w rak muted !" : `${left} warns bachich tmuted.`}`
      )
      .then((m) => setTimeout(() => m.delete(), 6000));
  }

  return { action, warns, timeouts, timeoutUntil };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function trackMessage(message) {
  const { author, guild, channel, content } = message;
  if (!guild) return;
  await Member.findOneAndUpdate(
    { userId: author.id, guildId: guild.id },
    {
      $set: { username: author.username, updatedAt: new Date() },
      $push: { lastMessages: { $each: [{ content, channelId: channel.id, channelName: channel.name ?? "unknown", timestamp: new Date() }], $slice: -5 } },
      $setOnInsert: { joinedAt: new Date() },
    },
    { upsert: true, new: true }
  );
}

async function ensureMember(guildMember) {
  await Member.findOneAndUpdate(
    { userId: guildMember.user.id, guildId: guildMember.guild.id },
    { $setOnInsert: { username: guildMember.user.username, lastMessages: [], badWordHistory: [], warns: 0, timeouts: 0, joinedAt: new Date(), updatedAt: new Date() } },
    { upsert: true, new: true }
  );
}

// ─── Events ───────────────────────────────────────────────────────────────────
client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));

client.on("guildMemberAdd", async (member) => {
  try { await ensureMember(member); }
  catch (err) { console.error("guildMemberAdd error:", err); }
});

// ── Main message handler ──────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const { guild, channel, member } = message;
  const content    = message.content.toLowerCase();
  const allContent = content + " " + getForwardedContent(message);

  // ── Load guild config ──────────────────────────────────────────────────────
  const cfg = await getConfig(guild.id);

  // ── !config command (always allowed regardless of channel restrictions) ────
  if (content.startsWith("!config")) {
    const args = message.content.trim().split(/\s+/).slice(1);
    await handleConfig(message, args);
    return;
  }

  // ── Channel restriction — ignore messages outside allowed channels ──────────
  // If allowedChannels is empty → no restriction (bot works everywhere)
  if (cfg.allowedChannels.size > 0 && !cfg.allowedChannels.has(channel.id)) return;

  // ── Role exemption — skip moderation for exempt roles ─────────────────────
  const isExempt = member?.roles?.cache.some((r) => cfg.exemptRoles.has(r.id));

  // ── Bad word detection (skipped for exempt roles) ─────────────────────────
  if (features.badwords && !isExempt) {
    const recentMessages = getRecentMessages(message.author.id, message);

    if (isBadInHistory(message.author.id, allContent)) {
      recentMessages.forEach((m) => m.message.delete().catch(() => {}));
      userMessageHistory.set(message.author.id, []);

      let result = { action: "warn", warns: 0, timeouts: 0, timeoutUntil: null };
      try { result = await handleOffence(message, message.content); }
      catch (err) { console.error("handleOffence error:", err); }

      if (features.logs) {
        const actionEmoji = { warn: "⚠️", timeout: "⏱️", ban: "🔨" }[result.action];
        const actionColor = { warn: Colors.warn, timeout: Colors.timeout, ban: Colors.ban }[result.action];
        const fields = [
          { name: "User",    value: `${message.author} (${message.author.tag})`, inline: true },
          { name: "Channel", value: `${message.channel}`, inline: true },
          { name: "Action",  value: result.action.toUpperCase(), inline: true },
          { name: "Warns",   value: `${result.warns}/${WARNS_BEFORE_TIMEOUT}`, inline: true },
          { name: "Timeouts",value: `${result.timeouts}/${TIMEOUTS_BEFORE_BAN}`, inline: true },
        ];
        if (result.timeoutUntil) fields.push({ name: "Muted Until", value: `<t:${Math.floor(result.timeoutUntil / 1000)}:F>`, inline: true });
        fields.push({ name: "Content", value: `\`\`\`${message.content.slice(0, 300)}\`\`\`` });
        fields.push({ name: "Time",    value: timestamp(), inline: true });
        sendLog(guild, { color: actionColor, emoji: actionEmoji, title: `Bad Word — ${result.action.toUpperCase()}`, fields, footer: "Warns reset after 30 min • Timeouts reset after 2 h" });
      }
      return;
    }
  }

  // ── Track clean message ───────────────────────────────────────────────────
  try { await trackMessage(message); }
  catch (err) { console.error("trackMessage error:", err); }
});

// ── Edit handler ──────────────────────────────────────────────────────────────
client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (newMessage.author?.bot || !newMessage.guild) return;
  if (!features.badwords || !newMessage.content) return;

  const cfg      = await getConfig(newMessage.guild.id);
  const isExempt = newMessage.member?.roles?.cache.some((r) => cfg.exemptRoles.has(r.id));
  if (isExempt) return;

  if (cfg.allowedChannels.size > 0 && !cfg.allowedChannels.has(newMessage.channel.id)) return;

  const allContent = newMessage.content.toLowerCase() + " " + getForwardedContent(newMessage);
  if (!isBadContent(allContent)) return;

  newMessage.delete().catch(() => {});

  let result = { action: "warn", warns: 0, timeouts: 0, timeoutUntil: null };
  try { result = await handleOffence(newMessage, newMessage.content); }
  catch (err) { console.error("handleOffence (edit) error:", err); }

  if (result.action === "warn") {
    newMessage.channel
      .send(`${newMessage.author}, fe9t bik ta3mel fi edit — arka7 takel ban rak .`)
      .then((m) => setTimeout(() => m.delete(), 5000));
  }

  if (features.logs) {
    const actionEmoji = { warn: "⚠️", timeout: "⏱️", ban: "🔨" }[result.action];
    const actionColor = { warn: Colors.warn, timeout: Colors.timeout, ban: Colors.ban }[result.action];
    sendLog(newMessage.guild, {
      color: actionColor, emoji: actionEmoji,
      title: `Bad Word in Edit — ${result.action.toUpperCase()}`,
      fields: [
        { name: "User",    value: `${newMessage.author} (${newMessage.author.tag})`, inline: true },
        { name: "Channel", value: `${newMessage.channel}`, inline: true },
        { name: "Action",  value: result.action.toUpperCase(), inline: true },
        { name: "Warns",   value: `${result.warns}/${WARNS_BEFORE_TIMEOUT}`, inline: true },
        { name: "Timeouts",value: `${result.timeouts}/${TIMEOUTS_BEFORE_BAN}`, inline: true },
        { name: "Edited Content", value: `\`\`\`${newMessage.content.slice(0, 300)}\`\`\`` },
        { name: "Time",    value: timestamp(), inline: true },
      ],
      footer: "Message deleted automatically",
    });
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.TOKEN).catch((err) => console.error("Login error:", err));