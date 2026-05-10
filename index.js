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
// ══════════════════════════════════════════════════════════════════════════════
const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  allowedChannels: { type: [String], default: [] },
  exemptRoles:     { type: [String], default: [] },
  configRoles:     { type: [String], default: [] },
  logChannelId:    { type: String,   default: null },  // null = fall back to name-based lookup
  updatedAt: { type: Date, default: Date.now },
});
const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

const configCache = new Map();

async function getConfig(guildId) {
  if (configCache.has(guildId)) return configCache.get(guildId);
  let doc = await GuildConfig.findOne({ guildId });
  if (!doc) doc = await GuildConfig.create({ guildId });
  const cfg = {
    allowedChannels: new Set(doc.allowedChannels),
    exemptRoles:     new Set(doc.exemptRoles),
    configRoles:     new Set(doc.configRoles),
    logChannelId:    doc.logChannelId ?? null,
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
    GatewayIntentBits.GuildVoiceStates,   // needed for voice logs
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

async function getLogChannelId(guildId) {
  if (configCache.has(guildId)) return configCache.get(guildId).logChannelId ?? null;
  const doc = await GuildConfig.findOne({ guildId });
  return doc?.logChannelId ?? null;
}

function getLogChannel(guild, logChannelId) {
  if (logChannelId) return guild.channels.cache.get(logChannelId) ?? null;
  return guild.channels.cache.find((ch) => ch.name === LOG_CHANNEL_NAME) ?? null;
}
async function sendLog(guild, { color, emoji, title, fields, footer }, logChannelId) {
  if (!features.logs) return;
  const resolvedId = logChannelId ?? await getLogChannelId(guild.id);
  const ch = getLogChannel(guild, resolvedId);
  if (!ch) return;
  const embed = new EmbedBuilder().setColor(color).setTitle(`${emoji}  ${title}`).addFields(fields).setTimestamp();
  if (footer) embed.setFooter({ text: footer });
  ch.send({ embeds: [embed] }).catch(() => {});
}
function timestamp() { return `<t:${Math.floor(Date.now() / 1000)}:T>`; }

const Colors = {
  warn:    "#FEE75C",
  timeout: "#E67E22",
  ban:     "#FF0000",
  info:    "#5865F2",
  ok:      "#57F287",
  error:   "#ED4245",
  join:    "#43B581",
  leave:   "#747F8D",
  delete:  "#ED4245",
  edit:    "#FAA61A",
  voice:   "#9B59B6",
  nick:    "#3498DB",
  unban:   "#57F287",
};

// ══════════════════════════════════════════════════════════════════════════════
//  PERMISSION SYSTEM
// ══════════════════════════════════════════════════════════════════════════════

const SUPERUSERS = new Set(["544462092602966026"]); // 3amer3823 — full access, no restrictions

function isSuperuser(member) {
  return SUPERUSERS.has(member.user.id);
}
function hasManageGuild(member) {
  return isSuperuser(member) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}
function hasConfigAccess(member, cfg) {
  return (
    isSuperuser(member) ||
    hasManageGuild(member) ||
    member.roles.cache.some((r) => cfg.configRoles.has(r.id))
  );
}

// ── Help strings ──────────────────────────────────────────────────────────────
const ADMIN_HELP =
  "**!admin** *(Manage Server only)*\n\n" +
  "`!admin role add @role` — give a role access to !config and !toggle\n" +
  "`!admin role remove @role` — revoke that access\n" +
  "`!admin role list` — show which roles can use !config and !toggle\n" +
  "`!admin show` — show full server channels & roles with their IDs";

const CONFIG_HELP =
  "**!config** *(admin role or Manage Server required)*\n\n" +
  "**Channels — which channels the bot reads & moderates:**\n" +
  "`!config channel add #channel` — add a channel (empty list = all channels)\n" +
  "`!config channel remove #channel` — remove a channel\n" +
  "`!config channel list` — show active channels\n" +
  "`!config channel clear` — remove all restrictions\n\n" +
  "**Exempt roles — skip bad-word detection entirely:**\n" +
  "`!config role add @role` — exempt a role\n" +
  "`!config role remove @role` — remove exemption\n" +
  "`!config role list` — show exempt roles\n" +
  "`!config role clear` — clear all exemptions\n\n" +
  "**Log channel:**\n" +
  "`!config logs set #channel` — set the log channel\n" +
  "`!config logs clear` — go back to name-based fallback (📊・brew-logs)\n" +
  "`!config logs show` — show current log channel\n\n" +
  "`!config show` — show full current config";

const TOGGLE_HELP =
  "**!toggle** *(admin role or Manage Server required)*\n" +
  "`!toggle badwords` — turn bad-word detection on/off\n" +
  "`!toggle logs` — turn mod-log embeds on/off\n" +
  "`!toggle status` — show current feature states";

// ══════════════════════════════════════════════════════════════════════════════
//  !admin
// ══════════════════════════════════════════════════════════════════════════════
async function handleAdmin(message, args) {
  if (!hasManageGuild(message.member)) {
    return message.reply("ma3andekch permission. lazem **Manage Server** bch testa3mel !admin.")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }

  const sub     = args[0]?.toLowerCase();
  const action  = args[1]?.toLowerCase();
  const guildId = message.guild.id;

  if (sub === "show" || !sub) {
    const doc = await GuildConfig.findOne({ guildId }) ?? { configRoles: [] };
    const configRoleList = doc.configRoles?.length
      ? doc.configRoles.map((id) => `<@&${id}>`).join(", ")
      : "None — only Manage Server users can use !config and !toggle";
    const allChannels = message.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => `#${c.name} — \`${c.id}\``)
      .join("\n") || "none";
    const allRoles = message.guild.roles.cache
      .filter((r) => !r.managed && r.id !== message.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `@${r.name} — \`${r.id}\``)
      .join("\n") || "none";
    const embed = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("🔐  Admin Panel")
      .addFields(
        { name: "🔧 Roles with !config & !toggle access", value: configRoleList },
        { name: "📋 All text channels (name — ID)", value: allChannels.slice(0, 1020) },
        { name: "🏷️ All roles (name — ID)", value: allRoles.slice(0, 1020) },
      )
      .setFooter({ text: "Use these IDs with !config channel add / !config role add" })
      .setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  if (sub === "role") {
    if (action === "list") {
      const doc = await GuildConfig.findOne({ guildId }) ?? { configRoles: [] };
      const list = doc.configRoles?.length
        ? doc.configRoles.map((id) => `<@&${id}>`).join(", ")
        : "None.";
      return message.reply(`🔧 Roles with !config & !toggle access: ${list}`);
    }
    const targetRole = message.mentions.roles.first();
    if (!targetRole)
      return message.reply("Mentionni el role. ex: `!admin role add @Admin`")
        .then((m) => setTimeout(() => m.delete(), 5000));
    if (action === "add") {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $addToSet: { configRoles: targetRole.id }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> can now use \`!config\` and \`!toggle\`.`);
    }
    if (action === "remove") {
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $pull: { configRoles: targetRole.id }, $set: { updatedAt: new Date() } }
      );
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> no longer has access to \`!config\` and \`!toggle\`.`);
    }
    return message.reply(ADMIN_HELP);
  }

  return message.reply(ADMIN_HELP);
}

// ══════════════════════════════════════════════════════════════════════════════
//  !config
// ══════════════════════════════════════════════════════════════════════════════
async function handleConfig(message, args, cfg) {
  if (!hasConfigAccess(message.member, cfg)) {
    return message.reply("ma3andekch permission. 9arra9 badmin bch ta5ou el access.")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }

  const sub     = args[0]?.toLowerCase();
  const action  = args[1]?.toLowerCase();
  const guildId = message.guild.id;

  if (sub === "show" || !sub) {
    const doc = await GuildConfig.findOne({ guildId }) ?? { allowedChannels: [], exemptRoles: [], logChannelId: null };
    const chList = doc.allowedChannels.length
      ? doc.allowedChannels.map((id) => `<#${id}>`).join(", ")
      : "All channels (no restriction)";
    const exemptList = doc.exemptRoles.length
      ? doc.exemptRoles.map((id) => `<@&${id}>`).join(", ")
      : "None";
    const logChDisplay = doc.logChannelId
      ? `<#${doc.logChannelId}> (ID: \`${doc.logChannelId}\`)`
      : `Name-based fallback: **${LOG_CHANNEL_NAME}**`;
    const embed = new EmbedBuilder()
      .setColor(Colors.info)
      .setTitle("⚙️  Bot Config")
      .addFields(
        { name: "✅ Active channels (bot reads & moderates)", value: chList },
        { name: "🛡️ Exempt roles (no warns/detection)", value: exemptList },
        { name: "📋 Log channel", value: logChDisplay },
      )
      .setFooter({ text: "Use !admin show to see all channel & role IDs" })
      .setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  if (sub === "channel") {
    if (action === "list") {
      const doc = await GuildConfig.findOne({ guildId }) ?? { allowedChannels: [] };
      const list = doc.allowedChannels.length
        ? doc.allowedChannels.map((id) => `<#${id}>`).join(", ")
        : "No restriction — bot active in all channels.";
      return message.reply(`📋 Active channels: ${list}`);
    }
    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { allowedChannels: [], updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply("✅ Channel restriction cleared — bot active in all channels.");
    }
    const targetChannel = message.mentions.channels.first();
    if (!targetChannel)
      return message.reply("Mentionni el channel. ex: `!config channel add #general`")
        .then((m) => setTimeout(() => m.delete(), 5000));
    if (action === "add") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $addToSet: { allowedChannels: targetChannel.id }, $set: { updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply(`✅ <#${targetChannel.id}> added — bot now active there.`);
    }
    if (action === "remove") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $pull: { allowedChannels: targetChannel.id }, $set: { updatedAt: new Date() } });
      invalidateCache(guildId);
      return message.reply(`✅ <#${targetChannel.id}> removed.`);
    }
    return message.reply(CONFIG_HELP);
  }

  if (sub === "role") {
    const targetRole = message.mentions.roles.first();
    if (action === "list") {
      const doc = await GuildConfig.findOne({ guildId }) ?? { exemptRoles: [] };
      const list = doc.exemptRoles.length ? doc.exemptRoles.map((id) => `<@&${id}>`).join(", ") : "None.";
      return message.reply(`🛡️ Exempt roles: ${list}`);
    }
    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { exemptRoles: [], updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply("✅ All exempt roles cleared.");
    }
    if (action === "add") {
      if (!targetRole) return message.reply("Mentionni el role. ex: `!config role add @Mod`").then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $addToSet: { exemptRoles: targetRole.id }, $set: { updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> is now exempt from bad-word detection.`);
    }
    if (action === "remove") {
      if (!targetRole) return message.reply("Mentionni el role. ex: `!config role remove @Mod`").then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $pull: { exemptRoles: targetRole.id }, $set: { updatedAt: new Date() } });
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> exemption removed.`);
    }
    return message.reply(CONFIG_HELP);
  }

  // ── !config logs ───────────────────────────────────────────────────────────
  if (sub === "logs") {
    if (action === "show") {
      const doc = await GuildConfig.findOne({ guildId });
      const logChDisplay = doc?.logChannelId
        ? `<#${doc.logChannelId}> (\`${doc.logChannelId}\`)`
        : `Name-based fallback: **${LOG_CHANNEL_NAME}**`;
      return message.reply(`📋 Log channel: ${logChDisplay}`);
    }
    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { logChannelId: null, updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply(`✅ Log channel cleared — falling back to **${LOG_CHANNEL_NAME}** by name.`);
    }
    if (action === "set") {
      const targetChannel = message.mentions.channels.first();
      if (!targetChannel)
        return message.reply("Mentionni el channel. ex: `!config logs set #logs`")
          .then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { logChannelId: targetChannel.id, updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply(`✅ Log channel set to <#${targetChannel.id}>.`);
    }
    return message.reply(CONFIG_HELP);
  }

  return message.reply(CONFIG_HELP);
}

// ══════════════════════════════════════════════════════════════════════════════
//  !toggle
// ══════════════════════════════════════════════════════════════════════════════
async function handleToggle(message, args, cfg) {
  if (!hasConfigAccess(message.member, cfg)) {
    return message.reply("ma3andekch permission. 9arra9 badmin bch ta5ou el access.")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }

  const feature = args[0]?.toLowerCase();

  if (feature === "status" || !feature) {
    return message.reply(
      "**Feature status:**\n" +
      Object.entries(features).map(([k, v]) => `• \`${k}\`: ${v ? "🟢 on" : "🔴 off"}`).join("\n")
    );
  }

  if (!Object.prototype.hasOwnProperty.call(features, feature)) {
    return message.reply(TOGGLE_HELP);
  }

  features[feature] = !features[feature];
  message.reply(`✅ \`${feature}\` is now ${features[feature] ? "🟢 on" : "🔴 off"}`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  !fassa5 [amount] — bulk delete messages (default 10, max 100)
//  Requires: Manage Messages OR superuser
// ══════════════════════════════════════════════════════════════════════════════

async function handleFassa5(message, args, cfg) {
  const canUse = hasConfigAccess(message.member, cfg);

  if (!canUse) {
    return message.reply("ma3andekch permission. lazem **Manage Messages** bch testa3mel !fassa5.")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }

  const amount = parseInt(args[0]);

  if (!args[0]) {
    return message.reply("ekteb el 3adad. ex: `!fassa5 50`")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }

  if (isNaN(amount) || amount < 1 || amount > 100) {
    return message.reply("el 3adad lazem ykoun bin 1 w 100. ex: `!fassa5 50`")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }

  // Delete the command message first
  await message.delete().catch(() => {});

  // Discord only lets you bulk-delete messages newer than 14 days
  const deleted = await message.channel.bulkDelete(amount, true).catch((err) => {
    console.error("fassa5 bulkDelete error:", err);
    return null;
  });

  if (!deleted) {
    return message.channel
      .send("❌ Ma9dartch namsah. taa9ad el bot 3andou **Manage Messages** permission.")
      .then((m) => setTimeout(() => m.delete(), 5000));
  }

  const confirm = await message.channel.send(
    `🗑️ Tmashah **${deleted.size}** message${deleted.size !== 1 ? "s" : ""} fi <#${message.channel.id}>.`
  );
  setTimeout(() => confirm.delete().catch(() => {}), 4000);

  if (features.logs) {
    const logChannelId = (await getConfig(message.guild.id)).logChannelId;
    sendLog(message.guild, {
      color: Colors.delete,
      emoji: "🗑️",
      title: "Bulk Delete (fassa5)",
      fields: [
        { name: "Moderator", value: `${message.author} (${message.author.tag})`, inline: true },
        { name: "Channel",   value: `${message.channel}`, inline: true },
        { name: "Deleted",   value: `${deleted.size} messages`, inline: true },
        { name: "Time",      value: timestamp(), inline: true },
      ],
    }, logChannelId);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  VOICE CHANNEL COMMANDS
//  !join_vc #channel  — bot joins a VC
//  !leave_vc          — bot leaves its current VC
//  !mute_vc           — toggle server-mute on the bot
//  !deafen_vc         — toggle server-deafen on the bot
//  Access: superuser | Manage Server | configRole
// ══════════════════════════════════════════════════════════════════════════════

async function handleJoinVC(message, args, cfg) {
  if (!hasConfigAccess(message.member, cfg))
    return message.reply("ma3andekch permission.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  // Accept a mentioned channel or find by name from args
  const mentioned = message.mentions.channels.first();
  const targetChannel = mentioned
    ?? message.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildVoice &&
               c.name.toLowerCase() === args.join(" ").toLowerCase()
      );

  if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {
    return message.reply("Ma9dartch nlqa el VC. ekteb `!join_vc #channel` wella `!join_vc channel-name`.")
      .then((m) => setTimeout(() => m.delete(), 5000));
  }

  try {
    await message.guild.members.me.voice.setChannel(targetChannel);
    message.reply(`✅ Bot joined **${targetChannel.name}**.`)
      .then((m) => setTimeout(() => m.delete(), 4000));
  } catch (err) {
    console.error("join_vc error:", err);
    message.reply("❌ Ma9dartch njoin. taa9ad el bot 3andou **Connect** permission fi dak el VC.")
      .then((m) => setTimeout(() => m.delete(), 5000));
  }
}

async function handleLeaveVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg))
    return message.reply("ma3andekch permission.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  const botVC = message.guild.members.me.voice.channel;
  if (!botVC)
    return message.reply("El bot mhoch fi VC.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  try {
    await message.guild.members.me.voice.setChannel(null);
    message.reply(`✅ Bot left **${botVC.name}**.`)
      .then((m) => setTimeout(() => m.delete(), 4000));
  } catch (err) {
    console.error("leave_vc error:", err);
    message.reply("❌ Ma9dartch nkhroj.")
      .then((m) => setTimeout(() => m.delete(), 5000));
  }
}

async function handleMuteVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg))
    return message.reply("ma3andekch permission.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  const me = message.guild.members.me;
  if (!me.voice.channel)
    return message.reply("El bot mhoch fi VC.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  const newMute = !me.voice.serverMute;
  try {
    await me.voice.setMute(newMute);
    message.reply(`✅ Bot is now **${newMute ? "🔇 server-muted" : "🔊 unmuted"}**.`)
      .then((m) => setTimeout(() => m.delete(), 4000));
  } catch (err) {
    console.error("mute_vc error:", err);
    message.reply("❌ Ma9dartch nbadel el mute.")
      .then((m) => setTimeout(() => m.delete(), 5000));
  }
}

async function handleDeafenVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg))
    return message.reply("ma3andekch permission.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  const me = message.guild.members.me;
  if (!me.voice.channel)
    return message.reply("El bot mhoch fi VC.")
      .then((m) => setTimeout(() => m.delete(), 4000));

  const newDeafen = !me.voice.serverDeaf;
  try {
    await me.voice.setDeaf(newDeafen);
    message.reply(`✅ Bot is now **${newDeafen ? "🔕 server-deafened" : "🔔 undeafened"}**.`)
      .then((m) => setTimeout(() => m.delete(), 4000));
  } catch (err) {
    console.error("deafen_vc error:", err);
    message.reply("❌ Ma9dartch nbadel el deafen.")
      .then((m) => setTimeout(() => m.delete(), 5000));
  }
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
      author.send("kool ban. 3 timeouts w mazelt ma fhemtech. bye.").catch(() => {});
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
        .send(`⏱️ ${author} , 3 warns w mazelt mafhemtech ro7ek — get muted **${durationStr}**. (timeout #${timeouts}/3)`)
        .then((m) => setTimeout(() => m.delete(), 8000));
      author.send(
        ` you are muted **${durationStr}** na99es melklam ezayed.\n` +
        `Timeout #${timeouts}/3 — eltimeout ejey ykoun akbar. arka7.`
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
        `${left === 1 ? "warn o5ra rak takel mute !" : `${left} warns mazalou and you will get muted.`}`
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

// ═══════════════════════════════════════════════════════════════════════════════
//  ███████╗██╗   ██╗███████╗███╗   ██╗████████╗    ██╗      ██████╗  ██████╗ ███████╗
//  ██╔════╝██║   ██║██╔════╝████╗  ██║╚══██╔══╝    ██║     ██╔═══██╗██╔════╝ ██╔════╝
//  █████╗  ██║   ██║█████╗  ██╔██╗ ██║   ██║       ██║     ██║   ██║██║  ███╗███████╗
//  ██╔══╝  ╚██╗ ██╔╝██╔══╝  ██║╚██╗██║   ██║       ██║     ██║   ██║██║   ██║╚════██║
//  ███████╗ ╚████╔╝ ███████╗██║ ╚████║   ██║        ███████╗╚██████╔╝╚██████╔╝███████║
//  ╚══════╝  ╚═══╝  ╚══════╝╚═╝  ╚═══╝  ╚═╝         ╚══════╝ ╚═════╝  ╚═════╝ ╚══════╝
// ═══════════════════════════════════════════════════════════════════════════════

// ── Member Join ───────────────────────────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  try { await ensureMember(member); } catch (err) { console.error("guildMemberAdd DB error:", err); }

  sendLog(member.guild, {
    color: Colors.join,
    emoji: "📥",
    title: "Member Joined",
    fields: [
      { name: "User",       value: `${member.user} (${member.user.tag})`, inline: true },
      { name: "Account Age", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: "User ID",    value: member.user.id, inline: true },
      { name: "Time",       value: timestamp(), inline: true },
    ],
    footer: `Member count: ${member.guild.memberCount}`,
  });
});

// ── Member Leave / Kick ───────────────────────────────────────────────────────
client.on("guildMemberRemove", async (member) => {
  // Wait briefly so the audit log has time to populate
  await new Promise((r) => setTimeout(r, 1500));

  let kickReason = null, kickExecutor = null;
  try {
    const auditLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
    const entry = auditLogs.entries.first();
    if (entry && entry.target?.id === member.id && Date.now() - entry.createdTimestamp < 5000) {
      kickReason   = entry.reason ?? "No reason provided";
      kickExecutor = entry.executor;
    }
  } catch { /* audit log unavailable */ }

  if (kickExecutor) {
    // It was a kick
    sendLog(member.guild, {
      color: Colors.error,
      emoji: "👢",
      title: "Member Kicked",
      fields: [
        { name: "User",      value: `${member.user.tag}`, inline: true },
        { name: "User ID",   value: member.user.id, inline: true },
        { name: "Kicked By", value: `${kickExecutor}`, inline: true },
        { name: "Reason",    value: kickReason, inline: false },
        { name: "Time",      value: timestamp(), inline: true },
      ],
    });
  } else {
    // Voluntary leave
    sendLog(member.guild, {
      color: Colors.leave,
      emoji: "📤",
      title: "Member Left",
      fields: [
        { name: "User",    value: `${member.user.tag}`, inline: true },
        { name: "User ID", value: member.user.id, inline: true },
        { name: "Joined",  value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : "Unknown", inline: true },
        { name: "Time",    value: timestamp(), inline: true },
      ],
      footer: `Member count: ${member.guild.memberCount}`,
    });
  }
});

// ── Ban ───────────────────────────────────────────────────────────────────────
client.on("guildBanAdd", async (ban) => {
  await new Promise((r) => setTimeout(r, 1000));
  let reason = ban.reason ?? "No reason provided", executor = null;
  try {
    const auditLogs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 });
    const entry = auditLogs.entries.first();
    if (entry && entry.target?.id === ban.user.id) {
      reason   = entry.reason ?? reason;
      executor = entry.executor;
    }
  } catch { }

  sendLog(ban.guild, {
    color: Colors.ban,
    emoji: "🔨",
    title: "Member Banned",
    fields: [
      { name: "User",    value: `${ban.user.tag}`, inline: true },
      { name: "User ID", value: ban.user.id, inline: true },
      { name: "Banned By", value: executor ? `${executor}` : "Unknown", inline: true },
      { name: "Reason",  value: reason },
      { name: "Time",    value: timestamp(), inline: true },
    ],
  });
});

// ── Unban ─────────────────────────────────────────────────────────────────────
client.on("guildBanRemove", async (ban) => {
  await new Promise((r) => setTimeout(r, 1000));
  let executor = null;
  try {
    const auditLogs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 1 });
    const entry = auditLogs.entries.first();
    if (entry && entry.target?.id === ban.user.id) executor = entry.executor;
  } catch { }

  sendLog(ban.guild, {
    color: Colors.unban,
    emoji: "✅",
    title: "Member Unbanned",
    fields: [
      { name: "User",       value: `${ban.user.tag}`, inline: true },
      { name: "User ID",    value: ban.user.id, inline: true },
      { name: "Unbanned By", value: executor ? `${executor}` : "Unknown", inline: true },
      { name: "Time",       value: timestamp(), inline: true },
    ],
  });
});

// ── Timeout / Untimeout ───────────────────────────────────────────────────────
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  // ── Timeout applied ──────────────────────────────────────────────────────
  if (!oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil) {
    await new Promise((r) => setTimeout(r, 1000));
    let reason = "No reason provided", executor = null;
    try {
      const auditLogs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
      const entry = auditLogs.entries.find((e) => e.target?.id === newMember.id &&
        e.changes?.some((c) => c.key === "communication_disabled_until"));
      if (entry) { reason = entry.reason ?? reason; executor = entry.executor; }
    } catch { }

    sendLog(newMember.guild, {
      color: Colors.timeout,
      emoji: "⏱️",
      title: "Member Timed Out",
      fields: [
        { name: "User",       value: `${newMember.user.tag}`, inline: true },
        { name: "User ID",    value: newMember.user.id, inline: true },
        { name: "Timed Out By", value: executor ? `${executor}` : "Unknown", inline: true },
        { name: "Until",      value: `<t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:F>`, inline: true },
        { name: "Reason",     value: reason },
        { name: "Time",       value: timestamp(), inline: true },
      ],
    });
  }

  // ── Timeout removed ──────────────────────────────────────────────────────
  if (oldMember.communicationDisabledUntil && !newMember.communicationDisabledUntil) {
    await new Promise((r) => setTimeout(r, 1000));
    let executor = null;
    try {
      const auditLogs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
      const entry = auditLogs.entries.find((e) => e.target?.id === newMember.id &&
        e.changes?.some((c) => c.key === "communication_disabled_until"));
      if (entry) executor = entry.executor;
    } catch { }

    sendLog(newMember.guild, {
      color: Colors.ok,
      emoji: "🔓",
      title: "Member Untimeout",
      fields: [
        { name: "User",         value: `${newMember.user.tag}`, inline: true },
        { name: "User ID",      value: newMember.user.id, inline: true },
        { name: "Removed By",   value: executor ? `${executor}` : "Unknown / expired", inline: true },
        { name: "Time",         value: timestamp(), inline: true },
      ],
    });
  }

  // ── Nickname changed ──────────────────────────────────────────────────────
  if (oldMember.nickname !== newMember.nickname) {
    await new Promise((r) => setTimeout(r, 1000));
    let executor = null;
    try {
      const auditLogs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 });
      const entry = auditLogs.entries.find((e) => e.target?.id === newMember.id &&
        e.changes?.some((c) => c.key === "nick"));
      if (entry) executor = entry.executor;
    } catch { }

    sendLog(newMember.guild, {
      color: Colors.nick,
      emoji: "✏️",
      title: "Nickname Changed",
      fields: [
        { name: "User",       value: `${newMember.user.tag}`, inline: true },
        { name: "User ID",    value: newMember.user.id, inline: true },
        { name: "Changed By", value: executor ? `${executor}` : "Self", inline: true },
        { name: "Old Nick",   value: oldMember.nickname ?? "*none*", inline: true },
        { name: "New Nick",   value: newMember.nickname ?? "*none*", inline: true },
        { name: "Time",       value: timestamp(), inline: true },
      ],
    });
  }
});

// ── Message Deleted ───────────────────────────────────────────────────────────
client.on("messageDelete", async (message) => {
  // Ignore partial messages with no content, bot messages, and DMs
  if (!message.guild || message.author?.bot) return;
  if (!message.content && !message.attachments?.size) return;

  await new Promise((r) => setTimeout(r, 1000));
  let executor = null;
  try {
    const auditLogs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 1 });
    const entry = auditLogs.entries.first();
    // Only credit the executor if the delete was very recent and matches channel + author
    if (
      entry &&
      entry.target?.id === message.author?.id &&
      entry.extra?.channel?.id === message.channel.id &&
      Date.now() - entry.createdTimestamp < 5000
    ) {
      executor = entry.executor;
    }
  } catch { }

  const attachmentList = message.attachments?.size
    ? [...message.attachments.values()].map((a) => `[${a.name}](${a.url})`).join(", ")
    : null;

  const fields = [
    { name: "Author",  value: message.author ? `${message.author} (${message.author.tag})` : "Unknown", inline: true },
    { name: "Channel", value: `${message.channel}`, inline: true },
    { name: "Deleted By", value: executor ? `${executor}` : "Author / unknown", inline: true },
  ];
  if (message.content) fields.push({ name: "Content", value: `\`\`\`${message.content.slice(0, 900)}\`\`\`` });
  if (attachmentList) fields.push({ name: "Attachments", value: attachmentList });
  fields.push({ name: "Time", value: timestamp(), inline: true });

  sendLog(message.guild, {
    color: Colors.delete,
    emoji: "🗑️",
    title: "Message Deleted",
    fields,
  });
});

// ── Message Edited ────────────────────────────────────────────────────────────
client.on("messageUpdate", async (oldMessage, newMessage) => {
  // ─ Bad-word check on edited messages (existing logic) ─────────────────────
  if (newMessage.author?.bot || !newMessage.guild) return;
  if (!features.badwords || !newMessage.content) return;

  const cfg      = await getConfig(newMessage.guild.id);
  const isExempt = isSuperuser(newMessage.member) || newMessage.member?.roles?.cache.some((r) => cfg.exemptRoles.has(r.id));

  if (!isExempt && cfg.allowedChannels.size > 0 && !cfg.allowedChannels.has(newMessage.channel.id)) {
    // outside monitored channels — only log the edit, don't moderate
    if (oldMessage.content && oldMessage.content !== newMessage.content) {
      sendLog(newMessage.guild, {
        color: Colors.edit,
        emoji: "✏️",
        title: "Message Edited",
        fields: [
          { name: "Author",  value: `${newMessage.author} (${newMessage.author.tag})`, inline: true },
          { name: "Channel", value: `${newMessage.channel}`, inline: true },
          { name: "Before",  value: `\`\`\`${(oldMessage.content || "*empty*").slice(0, 400)}\`\`\`` },
          { name: "After",   value: `\`\`\`${newMessage.content.slice(0, 400)}\`\`\`` },
          { name: "Time",    value: timestamp(), inline: true },
        ],
        footer: "Message link: " + newMessage.url,
      });
    }
    return;
  }

  const allContent = newMessage.content.toLowerCase() + " " + getForwardedContent(newMessage);

  if (!isExempt && isBadContent(allContent)) {
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
    return;
  }

  // ─ Log clean edits ────────────────────────────────────────────────────────
  if (oldMessage.content && oldMessage.content !== newMessage.content && features.logs) {
    sendLog(newMessage.guild, {
      color: Colors.edit,
      emoji: "✏️",
      title: "Message Edited",
      fields: [
        { name: "Author",  value: `${newMessage.author} (${newMessage.author.tag})`, inline: true },
        { name: "Channel", value: `${newMessage.channel}`, inline: true },
        { name: "Before",  value: `\`\`\`${(oldMessage.content || "*empty*").slice(0, 400)}\`\`\`` },
        { name: "After",   value: `\`\`\`${newMessage.content.slice(0, 400)}\`\`\`` },
        { name: "Time",    value: timestamp(), inline: true },
      ],
      footer: "Message link: " + newMessage.url,
    });
  }
});

// ── Voice Channel Activity ────────────────────────────────────────────────────
client.on("voiceStateUpdate", (oldState, newState) => {
  const guild  = newState.guild ?? oldState.guild;
  const user   = newState.member?.user ?? oldState.member?.user;
  if (!guild || !user || user.bot) return;

  const oldCh = oldState.channel;
  const newCh = newState.channel;

  // Join
  if (!oldCh && newCh) {
    sendLog(guild, {
      color: Colors.voice,
      emoji: "🔊",
      title: "Voice Channel Joined",
      fields: [
        { name: "User",    value: `${user} (${user.tag})`, inline: true },
        { name: "Channel", value: newCh.name, inline: true },
        { name: "Time",    value: timestamp(), inline: true },
      ],
    });
    return;
  }

  // Leave
  if (oldCh && !newCh) {
    sendLog(guild, {
      color: Colors.leave,
      emoji: "🔇",
      title: "Voice Channel Left",
      fields: [
        { name: "User",    value: `${user} (${user.tag})`, inline: true },
        { name: "Channel", value: oldCh.name, inline: true },
        { name: "Time",    value: timestamp(), inline: true },
      ],
    });
    return;
  }

  // Move
  if (oldCh && newCh && oldCh.id !== newCh.id) {
    sendLog(guild, {
      color: Colors.voice,
      emoji: "🔀",
      title: "Voice Channel Moved",
      fields: [
        { name: "User",    value: `${user} (${user.tag})`, inline: true },
        { name: "From",    value: oldCh.name, inline: true },
        { name: "To",      value: newCh.name, inline: true },
        { name: "Time",    value: timestamp(), inline: true },
      ],
    });
  }
});

// ── Main message handler ──────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const { guild, channel, member } = message;
  const content    = message.content.toLowerCase();
  const allContent = content + " " + getForwardedContent(message);

  const cfg = await getConfig(guild.id);

  if (content.startsWith("!admin")) {
    await handleAdmin(message, message.content.trim().split(/\s+/).slice(1));
    return;
  }
  if (content.startsWith("!config")) {
    await handleConfig(message, message.content.trim().split(/\s+/).slice(1), cfg);
    return;
  }
  if (content.startsWith("!fassa5")) {
    await handleFassa5(message, message.content.trim().split(/\s+/).slice(1), cfg);
    return;
  }


  if (content.startsWith("!join_vc")) {
    await handleJoinVC(message, message.content.trim().split(/\s+/).slice(1), cfg);
    return;
  }
  if (content.startsWith("!leave_vc")) {
    await handleLeaveVC(message, cfg);
    return;
  }
  if (content.startsWith("!mute_vc") || content.startsWith("!unmute_vc")) {
    await handleMuteVC(message, cfg);
    return;
  }
  if (content.startsWith("!deafen_vc") || content.startsWith("!undeafen_vc")) {
    await handleDeafenVC(message, cfg);
    return;
  }


  const isExempt = isSuperuser(member) || member?.roles?.cache.some((r) => cfg.exemptRoles.has(r.id));

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
        sendLog(guild, { color: actionColor, emoji: actionEmoji, title: `Bad Word — ${result.action.toUpperCase()}`, fields, footer: "Warns reset after 30 min • Timeouts reset after 2 h" }, cfg.logChannelId);
      }
      return;
    }
  }

  try { await trackMessage(message); }
  catch (err) { console.error("trackMessage error:", err); }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));
client.login(process.env.TOKEN).catch((err) => console.error("Login error:", err));