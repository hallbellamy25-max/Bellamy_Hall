require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
} = require("@discordjs/voice");
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
  logChannelId:    { type: String,   default: null },
  // counting game
  countingChannelId: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});
const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);

const configCache = new Map();

async function getConfig(guildId) {
  if (configCache.has(guildId)) return configCache.get(guildId);
  let doc = await GuildConfig.findOne({ guildId });
  if (!doc) doc = await GuildConfig.create({ guildId });
  const cfg = {
    allowedChannels:    new Set(doc.allowedChannels),
    exemptRoles:        new Set(doc.exemptRoles),
    configRoles:        new Set(doc.configRoles),
    logChannelId:       doc.logChannelId ?? null,
    countingChannelId:  doc.countingChannelId ?? null,
  };
  configCache.set(guildId, cfg);
  return cfg;
}

function invalidateCache(guildId) {
  configCache.delete(guildId);
}

// ══════════════════════════════════════════════════════════════════════════════
//  SCHEMA: CountingState  (one doc per guild)
// ══════════════════════════════════════════════════════════════════════════════
const countingSchema = new mongoose.Schema({
  guildId:      { type: String, required: true, unique: true },
  count:        { type: Number, default: 0 },
  lastUserId:   { type: String, default: null },
  highScore:    { type: Number, default: 0 },
});
const CountingState = mongoose.model("CountingState", countingSchema);

const countingCache = new Map();

async function getCountingState(guildId) {
  if (countingCache.has(guildId)) return countingCache.get(guildId);
  let doc = await CountingState.findOne({ guildId });
  if (!doc) doc = await CountingState.create({ guildId });
  countingCache.set(guildId, { count: doc.count, lastUserId: doc.lastUserId, highScore: doc.highScore });
  return countingCache.get(guildId);
}

async function saveCountingState(guildId, state) {
  countingCache.set(guildId, state);
  await CountingState.findOneAndUpdate(
    { guildId },
    { $set: { count: state.count, lastUserId: state.lastUserId, highScore: state.highScore } },
    { upsert: true }
  );
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
  mentionWarns:      { type: Number, default: 0 },
  lastMentionWarnAt: { type: Date,   default: null },
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
    GatewayIntentBits.GuildVoiceStates,
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

// ══════════════════════════════════════════════════════════════════════════════
//  PROTECTED USERS
// ══════════════════════════════════════════════════════════════════════════════
const PROTECTED_USERS = new Set(["1432385060509581385"]);

const MENTION_WARNS_BEFORE_TIMEOUT = 3;
const MENTION_TIMEOUT_MS           = 10 * 60 * 1000;
const MENTION_WARN_RESET_MS        = 60 * 60 * 1000;

async function handleMentionOffence(message) {
  const { author, guild, channel } = message;
  if (SUPERUSERS.has(author.id) || PROTECTED_USERS.has(author.id)) return;

  const now = new Date();
  let doc = await Member.findOneAndUpdate(
    { userId: author.id, guildId: guild.id },
    { $setOnInsert: { joinedAt: now, updatedAt: now } },
    { upsert: true, new: true }
  );

  let mentionWarns = doc.mentionWarns ?? 0;
  const lastMentionWarnAt = doc.lastMentionWarnAt ?? null;
  if (lastMentionWarnAt && (now - lastMentionWarnAt) > MENTION_WARN_RESET_MS) mentionWarns = 0;

  mentionWarns += 1;

  if (mentionWarns >= MENTION_WARNS_BEFORE_TIMEOUT) {
    await Member.findOneAndUpdate(
      { userId: author.id, guildId: guild.id },
      { $set: { mentionWarns: 0, lastMentionWarnAt: now, updatedAt: now, username: author.username } }
    );
    const guildMember = await guild.members.fetch(author.id).catch(() => null);
    if (guildMember) await guildMember.timeout(MENTION_TIMEOUT_MS, "Repeated mentions of a protected user").catch(console.error);

    message.delete().catch(() => {});
    channel.send(`⏱️ ${author} taket **timeout 10 dakika** — 3 fois 3amalt mention lil owner. arka7 !`)
      .then((m) => setTimeout(() => m.delete(), 8000));
    author.send("🚫 Muted **10 minutes** because you mentioned the owner 3 times.\nRka7 w ma3adch dir haka.").catch(() => {});

    if (features.logs) {
      const cfg = await getConfig(guild.id);
      sendLog(guild, {
        color: Colors.timeout, emoji: "⏱️", title: "Mention Abuse — Timeout",
        fields: [
          { name: "User",     value: `${author} (${author.tag})`, inline: true },
          { name: "Channel",  value: `${channel}`, inline: true },
          { name: "Reason",   value: "Mentioned a protected user 3 times", inline: false },
          { name: "Duration", value: "10 minutes", inline: true },
          { name: "Time",     value: timestamp(), inline: true },
        ],
      }, cfg.logChannelId);
    }
  } else {
    await Member.findOneAndUpdate(
      { userId: author.id, guildId: guild.id },
      { $set: { mentionWarns, lastMentionWarnAt: now, updatedAt: now, username: author.username } }
    );
    message.delete().catch(() => {});
    const left = MENTION_WARNS_BEFORE_TIMEOUT - mentionWarns;
    channel.send(
      `⚠️ ${author} , ma tag lish el owner ! Warn **${mentionWarns}/${MENTION_WARNS_BEFORE_TIMEOUT}** — ` +
      `${left === 1 ? "marra o5ra w takel timeout !" : `${left} marrat mazalou w takel timeout.`}`
    ).then((m) => setTimeout(() => m.delete(), 6000));

    if (features.logs) {
      const cfg = await getConfig(guild.id);
      sendLog(guild, {
        color: Colors.warn, emoji: "⚠️", title: "Mention Abuse — Warn",
        fields: [
          { name: "User",    value: `${author} (${author.tag})`, inline: true },
          { name: "Channel", value: `${channel}`, inline: true },
          { name: "Warns",   value: `${mentionWarns}/${MENTION_WARNS_BEFORE_TIMEOUT}`, inline: true },
          { name: "Time",    value: timestamp(), inline: true },
        ],
      }, cfg.logChannelId);
    }
  }
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

// Collapse spaced-out letters: "n a k" → "nak", "z e b" → "zeb"
function collapseSpacedLetters(str) {
  // Repeatedly collapse until stable (handles "n a k e r" fully)
  let prev = "";
  while (prev !== str) {
    prev = str;
    str = str.replace(/(?<!\S)([a-z\u0600-\u06FF])\s(?=[a-z\u0600-\u06FF](\s|$))/g, "$1");
  }
  return str;
}

function normalize(str) {
  let s = str.toLowerCase();
  s = collapseSpacedLetters(s);                     // "n a k" → "nak"
  s = s.replace(/[^a-z0-9\u0600-\u06FF\s]/g, " "); // strip punctuation, keep spaces
  s = s.replace(/(.)\1+/g, "$1");                   // "naaak" → "nak"
  return s.trim();
}

// Tokenise into individual words
function getWords(str) {
  return normalize(str).split(/\s+/).filter(Boolean);
}

// Pre-normalise the bad word list once at startup
const normalizedBadWords = badWords.map((w) => normalize(w).trim()).filter(Boolean);

function isBadContent(content) {
  // Emoji check
  if (emojiWords.some((e) => content.includes(e))) return true;

  const words = getWords(content);
  const normalizedFull = normalize(content);

  return normalizedBadWords.some((bad) => {
    if (bad.includes(" ")) {
      // Multi-word phrase → substring match on full normalised string
      return normalizedFull.includes(bad);
    }
    // Single word → must match a whole word exactly (no substring matches)
    return words.includes(bad);
  });
}

function getForwardedContent(message) {
  return message.messageSnapshots
    ? [...message.messageSnapshots.values()].map((s) => s.content?.toLowerCase() || "").join(" ")
    : "";
}

// ─── Sliding window ───────────────────────────────────────────────────────────
const userMessageHistory = new Map();
const HISTORY_WINDOW    = 15_000; // 15 seconds
const HISTORY_MAX_COUNT = 10;     // max messages to keep per user

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
  const recent = hist
    .filter((m) => now - m.time < HISTORY_WINDOW)
    .slice(-HISTORY_MAX_COUNT); // cap by count too
  userMessageHistory.set(userId, recent);
  return recent;
}

function isBadInHistory(userId, content) {
  const history = userMessageHistory.get(userId) ?? [];
  const combined = history.map((m) => m.content).join(" ");

  // Check 1: current message alone
  if (isBadContent(content)) return true;

  // Check 2: spaced combined history (catches phrases split across messages)
  if (isBadContent(combined)) return true;

  // Check 3: strip ALL spaces from combined history (catches letter-by-letter evasion)
  const stripped = combined.replace(/\s+/g, "");
  if (normalizedBadWords.some((bad) => stripped.includes(bad.replace(/\s+/g, "")))) return true;

  return false;
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
const SUPERUSERS = new Set(["544462092602966026"]);

function isSuperuser(member) { return SUPERUSERS.has(member.user.id); }
function hasManageGuild(member) {
  return isSuperuser(member) || member.permissions.has(PermissionFlagsBits.ManageGuild);
}
function hasConfigAccess(member, cfg) {
  return isSuperuser(member) || hasManageGuild(member) ||
    member.roles.cache.some((r) => cfg.configRoles.has(r.id));
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
  "**Channels:**\n" +
  "`!config channel add #channel` / `remove` / `list` / `clear`\n\n" +
  "**Exempt roles:**\n" +
  "`!config role add @role` / `remove` / `list` / `clear`\n\n" +
  "**Log channel:**\n" +
  "`!config logs set #channel` / `clear` / `show`\n\n" +
  "**Counting channel:**\n" +
  "`!config counting set #channel` — set the counting channel\n" +
  "`!config counting clear` — disable counting\n" +
  "`!config counting show` — show current counting channel\n\n" +
  "`!config show` — show full current config";

const TOGGLE_HELP =
  "**!toggle** *(admin role or Manage Server required)*\n" +
  "`!toggle badwords` — turn bad-word detection on/off\n" +
  "`!toggle logs` — turn mod-log embeds on/off\n" +
  "`!toggle status` — show current feature states";

// ══════════════════════════════════════════════════════════════════════════════
//  COUNTING GAME HANDLER
// ══════════════════════════════════════════════════════════════════════════════
async function handleCounting(message) {
  const { author, guild, channel } = message;
  const input = message.content.trim();
  const num   = Number(input);

  const state = await getCountingState(guild.id);

  if (!Number.isInteger(num) || input === "") {
    await message.delete().catch(() => {});
    const reminder = await channel.send(
      `❌ ${author}, had el channel ghir lil counting ! Ekteb el rakam el jey: **${state.count + 1}**`
    );
    setTimeout(() => reminder.delete().catch(() => {}), 5000);
    return;
  }

  const expected = state.count + 1;
  const ruinedBy = author.tag;

  if (state.lastUserId === author.id) {
    const ruined = state.count;
    const newHS  = Math.max(state.highScore, ruined);
    await saveCountingState(guild.id, { count: 0, lastUserId: null, highScore: newHS });
    await message.react("❌").catch(() => {});
    await channel.send(
      `💥 **${ruinedBy}** 3amel count marra tounya w kharbha ! Count waqaf 3and **${ruined}**.\n` +
      `${newHS > state.highScore ? `🏆 New high score: **${newHS}** !` : `🏆 High score: **${newHS}**`}\n` +
      `Count yabda men **1** — yji wahed o5or !`
    );
    return;
  }

  if (num !== expected) {
    const ruined = state.count;
    const newHS  = Math.max(state.highScore, ruined);
    await saveCountingState(guild.id, { count: 0, lastUserId: null, highScore: newHS });
    await message.react("❌").catch(() => {});
    await channel.send(
      `💥 **${ruinedBy}** 3ta el rakam el ghalet ! El rakam el sa7 kan **${expected}**, count waqaf 3and **${ruined}**.\n` +
      `${newHS > state.highScore ? `🏆 New high score: **${newHS}** !` : `🏆 High score: **${newHS}**`}\n` +
      `Count yabda men **1** !`
    );
    return;
  }

  const newHS = Math.max(state.highScore, num);
  await saveCountingState(guild.id, { count: num, lastUserId: author.id, highScore: newHS });
  await message.react("✅").catch(() => {});

  if (num % 100 === 0) {
    await channel.send(`🎉 **${num}** — milestone ! Bravoooo !`);
  } else if (num % 50 === 0) {
    await channel.send(`🔥 **${num}** — 3la5er !`);
  }
}

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
      .setColor(Colors.info).setTitle("🔐  Admin Panel")
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
      const list = doc.configRoles?.length ? doc.configRoles.map((id) => `<@&${id}>`).join(", ") : "None.";
      return message.reply(`🔧 Roles with !config & !toggle access: ${list}`);
    }
    const targetRole = message.mentions.roles.first();
    if (!targetRole)
      return message.reply("Mentionni el role. ex: `!admin role add @Admin`")
        .then((m) => setTimeout(() => m.delete(), 5000));
    if (action === "add") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $addToSet: { configRoles: targetRole.id }, $set: { updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply(`✅ <@&${targetRole.id}> can now use \`!config\` and \`!toggle\`.`);
    }
    if (action === "remove") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $pull: { configRoles: targetRole.id }, $set: { updatedAt: new Date() } });
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
    const doc = await GuildConfig.findOne({ guildId }) ?? { allowedChannels: [], exemptRoles: [], logChannelId: null, countingChannelId: null };
    const chList     = doc.allowedChannels.length ? doc.allowedChannels.map((id) => `<#${id}>`).join(", ") : "All channels (no restriction)";
    const exemptList = doc.exemptRoles.length     ? doc.exemptRoles.map((id) => `<@&${id}>`).join(", ")   : "None";
    const logChDisplay      = doc.logChannelId      ? `<#${doc.logChannelId}> (\`${doc.logChannelId}\`)`           : `Name-based fallback: **${LOG_CHANNEL_NAME}**`;
    const countingChDisplay = doc.countingChannelId ? `<#${doc.countingChannelId}> (\`${doc.countingChannelId}\`)` : "Not set";
    const embed = new EmbedBuilder()
      .setColor(Colors.info).setTitle("⚙️  Bot Config")
      .addFields(
        { name: "✅ Active channels",  value: chList },
        { name: "🛡️ Exempt roles",    value: exemptList },
        { name: "📋 Log channel",     value: logChDisplay },
        { name: "🔢 Counting channel", value: countingChDisplay },
      )
      .setFooter({ text: "Use !admin show to see all channel & role IDs" })
      .setTimestamp();
    return message.channel.send({ embeds: [embed] });
  }

  if (sub === "channel") {
    if (action === "list") {
      const doc = await GuildConfig.findOne({ guildId }) ?? { allowedChannels: [] };
      const list = doc.allowedChannels.length ? doc.allowedChannels.map((id) => `<#${id}>`).join(", ") : "No restriction — bot active in all channels.";
      return message.reply(`📋 Active channels: ${list}`);
    }
    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { allowedChannels: [], updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply("✅ Channel restriction cleared — bot active in all channels.");
    }
    const targetChannel = message.mentions.channels.first();
    if (!targetChannel) return message.reply("Mentionni el channel. ex: `!config channel add #general`").then((m) => setTimeout(() => m.delete(), 5000));
    if (action === "add") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $addToSet: { allowedChannels: targetChannel.id }, $set: { updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId); return message.reply(`✅ <#${targetChannel.id}> added.`);
    }
    if (action === "remove") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $pull: { allowedChannels: targetChannel.id }, $set: { updatedAt: new Date() } });
      invalidateCache(guildId); return message.reply(`✅ <#${targetChannel.id}> removed.`);
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
      invalidateCache(guildId); return message.reply("✅ All exempt roles cleared.");
    }
    if (action === "add") {
      if (!targetRole) return message.reply("Mentionni el role. ex: `!config role add @Mod`").then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $addToSet: { exemptRoles: targetRole.id }, $set: { updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId); return message.reply(`✅ <@&${targetRole.id}> is now exempt from bad-word detection.`);
    }
    if (action === "remove") {
      if (!targetRole) return message.reply("Mentionni el role. ex: `!config role remove @Mod`").then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $pull: { exemptRoles: targetRole.id }, $set: { updatedAt: new Date() } });
      invalidateCache(guildId); return message.reply(`✅ <@&${targetRole.id}> exemption removed.`);
    }
    return message.reply(CONFIG_HELP);
  }

  if (sub === "logs") {
    if (action === "show") {
      const doc = await GuildConfig.findOne({ guildId });
      const logChDisplay = doc?.logChannelId ? `<#${doc.logChannelId}> (\`${doc.logChannelId}\`)` : `Name-based fallback: **${LOG_CHANNEL_NAME}**`;
      return message.reply(`📋 Log channel: ${logChDisplay}`);
    }
    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { logChannelId: null, updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId); return message.reply(`✅ Log channel cleared — falling back to **${LOG_CHANNEL_NAME}** by name.`);
    }
    if (action === "set") {
      const targetChannel = message.mentions.channels.first();
      if (!targetChannel) return message.reply("Mentionni el channel. ex: `!config logs set #logs`").then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { logChannelId: targetChannel.id, updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId); return message.reply(`✅ Log channel set to <#${targetChannel.id}>.`);
    }
    return message.reply(CONFIG_HELP);
  }

  if (sub === "counting") {
    if (action === "show") {
      const doc = await GuildConfig.findOne({ guildId });
      const display = doc?.countingChannelId ? `<#${doc.countingChannelId}> (\`${doc.countingChannelId}\`)` : "Not set.";
      return message.reply(`🔢 Counting channel: ${display}`);
    }
    if (action === "clear") {
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { countingChannelId: null, updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      return message.reply("✅ Counting channel cleared — counting game disabled.");
    }
    if (action === "set") {
      const targetChannel = message.mentions.channels.first();
      if (!targetChannel) return message.reply("Mentionni el channel. ex: `!config counting set #counting`").then((m) => setTimeout(() => m.delete(), 5000));
      await GuildConfig.findOneAndUpdate({ guildId }, { $set: { countingChannelId: targetChannel.id, updatedAt: new Date() } }, { upsert: true });
      invalidateCache(guildId);
      const countCh = message.guild.channels.cache.get(targetChannel.id);
      if (countCh) countCh.send("🔢 Counting game is now active here! Start from **1** — each person must say the next number. No double counting!");
      return message.reply(`✅ Counting channel set to <#${targetChannel.id}>.`);
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
    return message.reply("**Feature status:**\n" + Object.entries(features).map(([k, v]) => `• \`${k}\`: ${v ? "🟢 on" : "🔴 off"}`).join("\n"));
  }
  if (!Object.prototype.hasOwnProperty.call(features, feature)) return message.reply(TOGGLE_HELP);
  features[feature] = !features[feature];
  message.reply(`✅ \`${feature}\` is now ${features[feature] ? "🟢 on" : "🔴 off"}`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  !fassa5
// ══════════════════════════════════════════════════════════════════════════════
async function handleFassa5(message, args, cfg) {
  if (!hasConfigAccess(message.member, cfg)) {
    return message.reply("ma3andekch permission. lazem **Manage Messages** bch testa3mel !fassa5.")
      .then((m) => setTimeout(() => m.delete(), 4000));
  }
  if (!args[0]) return message.reply("ekteb el 3adad. ex: `!fassa5 50`").then((m) => setTimeout(() => m.delete(), 4000));
  const amount = parseInt(args[0]);
  if (isNaN(amount) || amount < 1 || amount > 100) return message.reply("el 3adad lazem ykoun bin 1 w 100.").then((m) => setTimeout(() => m.delete(), 4000));

  await message.delete().catch(() => {});
  const deleted = await message.channel.bulkDelete(amount, true).catch(() => null);
  if (!deleted) return message.channel.send("❌ Ma9dartch namsah.").then((m) => setTimeout(() => m.delete(), 5000));

  const confirm = await message.channel.send(`🗑️ Tmashah **${deleted.size}** message${deleted.size !== 1 ? "s" : ""}.`);
  setTimeout(() => confirm.delete().catch(() => {}), 4000);

  if (features.logs) {
    const logChannelId = (await getConfig(message.guild.id)).logChannelId;
    sendLog(message.guild, {
      color: Colors.delete, emoji: "🗑️", title: "Bulk Delete (fassa5)",
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
// ══════════════════════════════════════════════════════════════════════════════
function resolveVoiceChannel(guild, rawArgs) {
  const input = rawArgs.join(" ").trim();
  if (!input) return null;
  const mentionMatch = input.match(/^<#(\d+)>$/);
  if (mentionMatch) { const ch = guild.channels.cache.get(mentionMatch[1]); return ch?.type === ChannelType.GuildVoice ? ch : null; }
  if (/^\d+$/.test(input)) { const ch = guild.channels.cache.get(input); return ch?.type === ChannelType.GuildVoice ? ch : null; }
  return guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice && c.name.toLowerCase() === input.toLowerCase()) ?? null;
}

async function handleJoinVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg)) return message.reply("ma3andekch permission.").then((m) => setTimeout(() => m.delete(), 4000));
  const rawArgs = message.content.trim().split(/\s+/).slice(1);
  const targetChannel = resolveVoiceChannel(message.guild, rawArgs);
  if (!targetChannel) return message.reply("najjamtech nod5ol lel VC. ekteb `!join_vc #channel` / ID / name").then((m) => setTimeout(() => m.delete(), 6000));
  try {
    const existing = getVoiceConnection(message.guild.id);
    if (existing) existing.destroy();
    joinVoiceChannel({ channelId: targetChannel.id, guildId: targetChannel.guild.id, adapterCreator: targetChannel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    message.reply(`✅ Bot joined **${targetChannel.name}** (\`${targetChannel.id}\`).`).then((m) => setTimeout(() => m.delete(), 4000));
  } catch (err) {
    console.error("join_vc error:", err);
    message.reply("❌ najjamtech nod5ol. taa9ad el bot 3andou **Connect** permission.").then((m) => setTimeout(() => m.delete(), 5000));
  }
}

async function handleLeaveVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg)) return message.reply("ma3andekch permission.").then((m) => setTimeout(() => m.delete(), 4000));
  const connection = getVoiceConnection(message.guild.id);
  if (!connection) return message.reply("El bot mahouch fi VC.").then((m) => setTimeout(() => m.delete(), 4000));
  try { connection.destroy(); message.reply("✅ Bot left the voice channel.").then((m) => setTimeout(() => m.delete(), 4000)); }
  catch (err) { console.error("leave_vc error:", err); message.reply("❌ njamtach no5roj.").then((m) => setTimeout(() => m.delete(), 5000)); }
}

async function handleMuteVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg)) return message.reply("ma3andekch permission.").then((m) => setTimeout(() => m.delete(), 4000));
  const me = message.guild.members.me;
  if (!me.voice.channel) return message.reply("El bot mahouch fi VC.").then((m) => setTimeout(() => m.delete(), 4000));
  const newMute = !me.voice.serverMute;
  try { await me.voice.setMute(newMute); message.reply(`✅ Bot is now **${newMute ? "🔇 server-muted" : "🔊 unmuted"}**.`).then((m) => setTimeout(() => m.delete(), 4000)); }
  catch (err) { console.error("mute_vc error:", err); message.reply("❌ njamtach na3mel mute.").then((m) => setTimeout(() => m.delete(), 5000)); }
}

async function handleDeafenVC(message, cfg) {
  if (!hasConfigAccess(message.member, cfg)) return message.reply("ma3andekch permission.").then((m) => setTimeout(() => m.delete(), 4000));
  const me = message.guild.members.me;
  if (!me.voice.channel) return message.reply("El bot mahouch fi VC.").then((m) => setTimeout(() => m.delete(), 4000));
  const newDeafen = !me.voice.serverDeaf;
  try { await me.voice.setDeaf(newDeafen); message.reply(`✅ Bot is now **${newDeafen ? "🔕 server-deafened" : "🔔 undeafened"}**.`).then((m) => setTimeout(() => m.delete(), 4000)); }
  catch (err) { console.error("deafen_vc error:", err); message.reply("❌ najjamtech na3mel deafen.").then((m) => setTimeout(() => m.delete(), 5000)); }
}

// ─── Offence handler ──────────────────────────────────────────────────────────
async function handleOffence(message, offendingContent) {
  const { author, guild, channel } = message;
  const now = new Date();
  let doc = await Member.findOneAndUpdate({ userId: author.id, guildId: guild.id }, { $setOnInsert: { joinedAt: now, updatedAt: now } }, { upsert: true, new: true });

  let { warns, lastWarnAt, timeouts, lastTimeoutAt } = doc;
  if (lastWarnAt    && (now - lastWarnAt)    > WARN_RESET_MS)    warns    = 0;
  if (lastTimeoutAt && (now - lastTimeoutAt) > TIMEOUT_RESET_MS) timeouts = 0;

  warns += 1;
  let action = "warn", timeoutUntil = null;

  if (warns >= WARNS_BEFORE_TIMEOUT) {
    timeouts += 1;
    if (timeouts >= TIMEOUTS_BEFORE_BAN) {
      action = "ban"; warns = 0;
      await Member.findOneAndUpdate({ userId: author.id, guildId: guild.id }, { $set: { warns: 0, timeouts, lastWarnAt: now, lastTimeoutAt: now, updatedAt: now, username: author.username }, $push: { badWordHistory: { $each: [{ content: offendingContent.slice(0, 500), channelId: channel.id, action: "ban", timestamp: now }], $slice: -50 } } });
      author.send("kool ban. 3 timeouts w mazelt ma fhemtech. bye.").catch(() => {});
      await guild.members.ban(author.id, { reason: "3 timeouts — repeated bad word offences" }).catch(console.error);
    } else {
      action = "timeout"; warns = 0;
      const duration = timeoutDurationFor(timeouts);
      timeoutUntil = new Date(now.getTime() + duration);
      await Member.findOneAndUpdate({ userId: author.id, guildId: guild.id }, { $set: { warns: 0, timeouts, lastWarnAt: now, lastTimeoutAt: now, updatedAt: now, username: author.username }, $push: { badWordHistory: { $each: [{ content: offendingContent.slice(0, 500), channelId: channel.id, action: "timeout", timestamp: now }], $slice: -50 } } });
      const guildMember = await guild.members.fetch(author.id).catch(() => null);
      if (guildMember) await guildMember.timeout(duration, "Repeated bad word offences").catch(console.error);
      const durationStr = msToHuman(duration);
      message.channel.send(`⏱️ ${author} , 3 warns w mazelt mafhemtech ro7ek — get muted **${durationStr}**. (timeout #${timeouts}/3)`).then((m) => setTimeout(() => m.delete(), 8000));
      author.send(`you are muted **${durationStr}**.\nTimeout #${timeouts}/3 — arka7.`).catch(() => {});
    }
  } else {
    await Member.findOneAndUpdate({ userId: author.id, guildId: guild.id }, { $set: { warns, timeouts, lastWarnAt: now, updatedAt: now, username: author.username }, $push: { badWordHistory: { $each: [{ content: offendingContent.slice(0, 500), channelId: channel.id, action: "warn", timestamp: now }], $slice: -50 } } });
    const left = WARNS_BEFORE_TIMEOUT - warns;
    message.channel.send(`⚠️ ${author} , yezi bla klam zayed ! Warn **${warns}/${WARNS_BEFORE_TIMEOUT}** — ${left === 1 ? "warn o5ra rak takel mute !" : `${left} warns mazalou.`}`).then((m) => setTimeout(() => m.delete(), 6000));
  }
  return { action, warns, timeouts, timeoutUntil };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function trackMessage(message) {
  const { author, guild, channel, content } = message;
  if (!guild) return;
  await Member.findOneAndUpdate({ userId: author.id, guildId: guild.id }, { $set: { username: author.username, updatedAt: new Date() }, $push: { lastMessages: { $each: [{ content, channelId: channel.id, channelName: channel.name ?? "unknown", timestamp: new Date() }], $slice: -5 } }, $setOnInsert: { joinedAt: new Date() } }, { upsert: true, new: true });
}
async function ensureMember(guildMember) {
  await Member.findOneAndUpdate({ userId: guildMember.user.id, guildId: guildMember.guild.id }, { $setOnInsert: { username: guildMember.user.username, lastMessages: [], badWordHistory: [], warns: 0, timeouts: 0, joinedAt: new Date(), updatedAt: new Date() } }, { upsert: true, new: true });
}

// ══════════════════════════════════════════════════════════════════════════════
//  EVENT LOGS
// ══════════════════════════════════════════════════════════════════════════════
client.on("guildMemberAdd", async (member) => {
  try { await ensureMember(member); } catch (err) { console.error("guildMemberAdd DB error:", err); }
  sendLog(member.guild, { color: Colors.join, emoji: "📥", title: "Member Joined", fields: [{ name: "User", value: `${member.user} (${member.user.tag})`, inline: true }, { name: "Account Age", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true }, { name: "User ID", value: member.user.id, inline: true }, { name: "Time", value: timestamp(), inline: true }], footer: `Member count: ${member.guild.memberCount}` });
});

client.on("guildMemberRemove", async (member) => {
  await new Promise((r) => setTimeout(r, 1500));
  let kickReason = null, kickExecutor = null;
  try {
    const auditLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
    const entry = auditLogs.entries.first();
    if (entry && entry.target?.id === member.id && Date.now() - entry.createdTimestamp < 5000) { kickReason = entry.reason ?? "No reason provided"; kickExecutor = entry.executor; }
  } catch { }
  if (kickExecutor) {
    sendLog(member.guild, { color: Colors.error, emoji: "👢", title: "Member Kicked", fields: [{ name: "User", value: `${member.user.tag}`, inline: true }, { name: "User ID", value: member.user.id, inline: true }, { name: "Kicked By", value: `${kickExecutor}`, inline: true }, { name: "Reason", value: kickReason, inline: false }, { name: "Time", value: timestamp(), inline: true }] });
  } else {
    sendLog(member.guild, { color: Colors.leave, emoji: "📤", title: "Member Left", fields: [{ name: "User", value: `${member.user.tag}`, inline: true }, { name: "User ID", value: member.user.id, inline: true }, { name: "Joined", value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : "Unknown", inline: true }, { name: "Time", value: timestamp(), inline: true }], footer: `Member count: ${member.guild.memberCount}` });
  }
});

client.on("guildBanAdd", async (ban) => {
  await new Promise((r) => setTimeout(r, 1000));
  let reason = ban.reason ?? "No reason provided", executor = null;
  try { const auditLogs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 }); const entry = auditLogs.entries.first(); if (entry && entry.target?.id === ban.user.id) { reason = entry.reason ?? reason; executor = entry.executor; } } catch { }
  sendLog(ban.guild, { color: Colors.ban, emoji: "🔨", title: "Member Banned", fields: [{ name: "User", value: `${ban.user.tag}`, inline: true }, { name: "User ID", value: ban.user.id, inline: true }, { name: "Banned By", value: executor ? `${executor}` : "Unknown", inline: true }, { name: "Reason", value: reason }, { name: "Time", value: timestamp(), inline: true }] });
});

client.on("guildBanRemove", async (ban) => {
  await new Promise((r) => setTimeout(r, 1000));
  let executor = null;
  try { const auditLogs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 1 }); const entry = auditLogs.entries.first(); if (entry && entry.target?.id === ban.user.id) executor = entry.executor; } catch { }
  sendLog(ban.guild, { color: Colors.unban, emoji: "✅", title: "Member Unbanned", fields: [{ name: "User", value: `${ban.user.tag}`, inline: true }, { name: "User ID", value: ban.user.id, inline: true }, { name: "Unbanned By", value: executor ? `${executor}` : "Unknown", inline: true }, { name: "Time", value: timestamp(), inline: true }] });
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (!oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil) {
    await new Promise((r) => setTimeout(r, 1000));
    let reason = "No reason provided", executor = null;
    try { const auditLogs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 }); const entry = auditLogs.entries.find((e) => e.target?.id === newMember.id && e.changes?.some((c) => c.key === "communication_disabled_until")); if (entry) { reason = entry.reason ?? reason; executor = entry.executor; } } catch { }
    sendLog(newMember.guild, { color: Colors.timeout, emoji: "⏱️", title: "Member Timed Out", fields: [{ name: "User", value: `${newMember.user.tag}`, inline: true }, { name: "User ID", value: newMember.user.id, inline: true }, { name: "Timed Out By", value: executor ? `${executor}` : "Unknown", inline: true }, { name: "Until", value: `<t:${Math.floor(newMember.communicationDisabledUntilTimestamp / 1000)}:F>`, inline: true }, { name: "Reason", value: reason }, { name: "Time", value: timestamp(), inline: true }] });
  }
  if (oldMember.communicationDisabledUntil && !newMember.communicationDisabledUntil) {
    await new Promise((r) => setTimeout(r, 1000));
    let executor = null;
    try { const auditLogs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 }); const entry = auditLogs.entries.find((e) => e.target?.id === newMember.id && e.changes?.some((c) => c.key === "communication_disabled_until")); if (entry) executor = entry.executor; } catch { }
    sendLog(newMember.guild, { color: Colors.ok, emoji: "🔓", title: "Member Untimeout", fields: [{ name: "User", value: `${newMember.user.tag}`, inline: true }, { name: "User ID", value: newMember.user.id, inline: true }, { name: "Removed By", value: executor ? `${executor}` : "Unknown / expired", inline: true }, { name: "Time", value: timestamp(), inline: true }] });
  }
  if (oldMember.nickname !== newMember.nickname) {
    await new Promise((r) => setTimeout(r, 1000));
    let executor = null;
    try { const auditLogs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 5 }); const entry = auditLogs.entries.find((e) => e.target?.id === newMember.id && e.changes?.some((c) => c.key === "nick")); if (entry) executor = entry.executor; } catch { }
    sendLog(newMember.guild, { color: Colors.nick, emoji: "✏️", title: "Nickname Changed", fields: [{ name: "User", value: `${newMember.user.tag}`, inline: true }, { name: "User ID", value: newMember.user.id, inline: true }, { name: "Changed By", value: executor ? `${executor}` : "Self", inline: true }, { name: "Old Nick", value: oldMember.nickname ?? "*none*", inline: true }, { name: "New Nick", value: newMember.nickname ?? "*none*", inline: true }, { name: "Time", value: timestamp(), inline: true }] });
  }
});

client.on("messageDelete", async (message) => {
  if (!message.guild || message.author?.bot) return;
  if (!message.content && !message.attachments?.size) return;
  await new Promise((r) => setTimeout(r, 1000));
  let executor = null;
  try { const auditLogs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 1 }); const entry = auditLogs.entries.first(); if (entry && entry.target?.id === message.author?.id && entry.extra?.channel?.id === message.channel.id && Date.now() - entry.createdTimestamp < 5000) executor = entry.executor; } catch { }
  const attachmentList = message.attachments?.size ? [...message.attachments.values()].map((a) => `[${a.name}](${a.url})`).join(", ") : null;
  const fields = [{ name: "Author", value: message.author ? `${message.author} (${message.author.tag})` : "Unknown", inline: true }, { name: "Channel", value: `${message.channel}`, inline: true }, { name: "Deleted By", value: executor ? `${executor}` : "Author / unknown", inline: true }];
  if (message.content)  fields.push({ name: "Content",     value: `\`\`\`${message.content.slice(0, 900)}\`\`\`` });
  if (attachmentList)   fields.push({ name: "Attachments", value: attachmentList });
  fields.push({ name: "Time", value: timestamp(), inline: true });
  sendLog(message.guild, { color: Colors.delete, emoji: "🗑️", title: "Message Deleted", fields });
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
  if (newMessage.author?.bot || !newMessage.guild) return;
  if (!features.badwords || !newMessage.content) return;
  const cfg      = await getConfig(newMessage.guild.id);
  const isExempt = isSuperuser(newMessage.member) || newMessage.member?.roles?.cache.some((r) => cfg.exemptRoles.has(r.id));
  if (!isExempt && cfg.allowedChannels.size > 0 && !cfg.allowedChannels.has(newMessage.channel.id)) {
    if (oldMessage.content && oldMessage.content !== newMessage.content) {
      sendLog(newMessage.guild, { color: Colors.edit, emoji: "✏️", title: "Message Edited", fields: [{ name: "Author", value: `${newMessage.author} (${newMessage.author.tag})`, inline: true }, { name: "Channel", value: `${newMessage.channel}`, inline: true }, { name: "Before", value: `\`\`\`${(oldMessage.content || "*empty*").slice(0, 400)}\`\`\`` }, { name: "After", value: `\`\`\`${newMessage.content.slice(0, 400)}\`\`\`` }, { name: "Time", value: timestamp(), inline: true }], footer: "Message link: " + newMessage.url });
    }
    return;
  }
  const allContent = newMessage.content.toLowerCase() + " " + getForwardedContent(newMessage);
  if (!isExempt && isBadContent(allContent)) {
    newMessage.delete().catch(() => {});
    let result = { action: "warn", warns: 0, timeouts: 0, timeoutUntil: null };
    try { result = await handleOffence(newMessage, newMessage.content); } catch (err) { console.error("handleOffence (edit) error:", err); }
    if (result.action === "warn") newMessage.channel.send(`${newMessage.author}, fe9t bik ta3mel fi edit — arka7 takel ban rak .`).then((m) => setTimeout(() => m.delete(), 5000));
    if (features.logs) {
      const actionEmoji = { warn: "⚠️", timeout: "⏱️", ban: "🔨" }[result.action];
      const actionColor = { warn: Colors.warn, timeout: Colors.timeout, ban: Colors.ban }[result.action];
      sendLog(newMessage.guild, { color: actionColor, emoji: actionEmoji, title: `Bad Word in Edit — ${result.action.toUpperCase()}`, fields: [{ name: "User", value: `${newMessage.author} (${newMessage.author.tag})`, inline: true }, { name: "Channel", value: `${newMessage.channel}`, inline: true }, { name: "Action", value: result.action.toUpperCase(), inline: true }, { name: "Warns", value: `${result.warns}/${WARNS_BEFORE_TIMEOUT}`, inline: true }, { name: "Timeouts", value: `${result.timeouts}/${TIMEOUTS_BEFORE_BAN}`, inline: true }, { name: "Edited Content", value: `\`\`\`${newMessage.content.slice(0, 300)}\`\`\`` }, { name: "Time", value: timestamp(), inline: true }], footer: "Message deleted automatically" });
    }
    return;
  }
  if (oldMessage.content && oldMessage.content !== newMessage.content && features.logs) {
    sendLog(newMessage.guild, { color: Colors.edit, emoji: "✏️", title: "Message Edited", fields: [{ name: "Author", value: `${newMessage.author} (${newMessage.author.tag})`, inline: true }, { name: "Channel", value: `${newMessage.channel}`, inline: true }, { name: "Before", value: `\`\`\`${(oldMessage.content || "*empty*").slice(0, 400)}\`\`\`` }, { name: "After", value: `\`\`\`${newMessage.content.slice(0, 400)}\`\`\`` }, { name: "Time", value: timestamp(), inline: true }], footer: "Message link: " + newMessage.url });
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild ?? oldState.guild;
  const user  = newState.member?.user ?? oldState.member?.user;
  if (!guild || !user || user.bot) return;
  const oldCh = oldState.channel, newCh = newState.channel;
  if (!oldCh && newCh) { sendLog(guild, { color: Colors.voice, emoji: "🔊", title: "Voice Channel Joined", fields: [{ name: "User", value: `${user} (${user.tag})`, inline: true }, { name: "Channel", value: newCh.name, inline: true }, { name: "Time", value: timestamp(), inline: true }] }); return; }
  if (oldCh && !newCh) { sendLog(guild, { color: Colors.leave, emoji: "🔇", title: "Voice Channel Left",   fields: [{ name: "User", value: `${user} (${user.tag})`, inline: true }, { name: "Channel", value: oldCh.name, inline: true }, { name: "Time", value: timestamp(), inline: true }] }); return; }
  if (oldCh && newCh && oldCh.id !== newCh.id) { sendLog(guild, { color: Colors.voice, emoji: "🔀", title: "Voice Channel Moved",  fields: [{ name: "User", value: `${user} (${user.tag})`, inline: true }, { name: "From", value: oldCh.name, inline: true }, { name: "To", value: newCh.name, inline: true }, { name: "Time", value: timestamp(), inline: true }] }); }
});

// ── Main message handler ──────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const { guild, member } = message;
  const content    = message.content.toLowerCase();
  const allContent = content + " " + getForwardedContent(message);
  const cfg        = await getConfig(guild.id);

  // ── Commands ──────────────────────────────────────────────────────────────
  if (content.startsWith("!admin"))    { await handleAdmin(message, message.content.trim().split(/\s+/).slice(1)); return; }
  if (content.startsWith("!config"))   { await handleConfig(message, message.content.trim().split(/\s+/).slice(1), cfg); return; }
  if (content.startsWith("!toggle"))   { await handleToggle(message, message.content.trim().split(/\s+/).slice(1), cfg); return; }
  if (content.startsWith("!fassa5"))   { await handleFassa5(message, message.content.trim().split(/\s+/).slice(1), cfg); return; }
  if (content.startsWith("!join_vc"))  { await handleJoinVC(message, cfg); return; }
  if (content.startsWith("!leave_vc")) { await handleLeaveVC(message, cfg); return; }
  if (content.startsWith("!mute_vc") || content.startsWith("!unmute_vc"))     { await handleMuteVC(message, cfg); return; }
  if (content.startsWith("!deafen_vc") || content.startsWith("!undeafen_vc")) { await handleDeafenVC(message, cfg); return; }

  // ── Counting channel ──────────────────────────────────────────────────────
  if (cfg.countingChannelId && message.channel.id === cfg.countingChannelId) {
    await handleCounting(message).catch(console.error);
    return;
  }

  // ── Protected user mention check ──────────────────────────────────────────
  if (!isSuperuser(member) && !PROTECTED_USERS.has(message.author.id)) {
    const mentionedProtected = message.mentions.users.some((u) => PROTECTED_USERS.has(u.id));
    if (mentionedProtected) { await handleMentionOffence(message).catch(console.error); return; }
  }

  // ── Bad word check ────────────────────────────────────────────────────────
  const isExempt = isSuperuser(member) || member?.roles?.cache.some((r) => cfg.exemptRoles.has(r.id));
  if (features.badwords && !isExempt) {
    const recentMessages = getRecentMessages(message.author.id, message);
    if (isBadInHistory(message.author.id, allContent)) {
      recentMessages.forEach((m) => m.message.delete().catch(() => {}));
      userMessageHistory.set(message.author.id, []);
      let result = { action: "warn", warns: 0, timeouts: 0, timeoutUntil: null };
      try { result = await handleOffence(message, message.content); } catch (err) { console.error("handleOffence error:", err); }
      if (features.logs) {
        const actionEmoji = { warn: "⚠️", timeout: "⏱️", ban: "🔨" }[result.action];
        const actionColor = { warn: Colors.warn, timeout: Colors.timeout, ban: Colors.ban }[result.action];
        const fields = [{ name: "User", value: `${message.author} (${message.author.tag})`, inline: true }, { name: "Channel", value: `${message.channel}`, inline: true }, { name: "Action", value: result.action.toUpperCase(), inline: true }, { name: "Warns", value: `${result.warns}/${WARNS_BEFORE_TIMEOUT}`, inline: true }, { name: "Timeouts", value: `${result.timeouts}/${TIMEOUTS_BEFORE_BAN}`, inline: true }];
        if (result.timeoutUntil) fields.push({ name: "Muted Until", value: `<t:${Math.floor(result.timeoutUntil / 1000)}:F>`, inline: true });
        fields.push({ name: "Content", value: `\`\`\`${message.content.slice(0, 300)}\`\`\`` }, { name: "Time", value: timestamp(), inline: true });
        sendLog(guild, { color: actionColor, emoji: actionEmoji, title: `Bad Word — ${result.action.toUpperCase()}`, fields, footer: "Warns reset after 30 min • Timeouts reset after 2 h" }, cfg.logChannelId);
      }
      return;
    }
  }

  try { await trackMessage(message); } catch (err) { console.error("trackMessage error:", err); }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));
client.login(process.env.TOKEN).catch((err) => console.error("Login error:", err));