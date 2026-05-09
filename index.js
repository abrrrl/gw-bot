const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
require('dotenv').config();

// ─────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────
const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS autoresponders (
    trigger TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    delete_msg INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sticky (
    channel_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS queue_entries (
    message_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    bought TEXT NOT NULL,
    paid TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS giveaways (
    message_id TEXT PRIMARY KEY,
    prize TEXT NOT NULL,
    winners INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    hosted_by TEXT NOT NULL,
    claim_str TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0,
    bonus_roles TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS giveaway_participants (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    entries INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS levels (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS xp_cooldown (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_xp INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS ping_on_join (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
`);

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const PREFIX      = '!';
const GUILD_BOTS  = process.env.GUILD_ID;
const GUILD_MAIN  = '1502429738868670484';
const QUEUE_CH    = '1291958364288450613';
const MODMAIL_CH  = '1500722506611294259';
const MODMAIL_NEW = '1502740755389616168';
const LEVEL_CH    = '1502720841287209132';
const CLIENT_ID   = process.env.CLIENT_ID;

// XP curve — starts at 75, scales gradually
function xpForLevel(level) {
  return Math.floor(75 * Math.pow(level, 1.6) + 75);
}

// Gender role IDs
const GENDER = {
  female: '1502733305265651732',
  male:   '1502733358625722629',
  none:   '1502733406679863427',
};

// Level roles by gender
const LEVEL_ROLES = {
  5:  { all: '1502736896667680908' },
  10: { female: '1502729343237885972', male: '1502729370618560712', none: '1502733201351643156' },
  25: { female: '1502729399320182946', male: '1502729558514733207', none: '1502733088881643682' },
  50: { female: '1502729613984403616', male: '1502729686470492232', none: '1502733262173376683' },
};

// Nickname prefixes by level and gender
const LEVEL_NICKS = {
  10: { female: '✾﹒﹒Lady﹒',                  male: '✾﹒﹒Lord﹒',                   none: '✾﹒﹒Lady/Lord﹒' },
  25: { female: '✾﹒﹒Viscountess﹒',            male: '✾﹒﹒Viscount﹒',               none: '✾﹒﹒Viscountess/Viscount﹒' },
  50: { female: '✾﹒﹒Duchess﹒',               male: '✾﹒﹒Duke﹒',                   none: '✾﹒﹒Duchess/Duke﹒' },
};

function getGender(member) {
  if (member.roles.cache.has(GENDER.female)) return 'female';
  if (member.roles.cache.has(GENDER.male))   return 'male';
  if (member.roles.cache.has(GENDER.none))   return 'none';
  return null;
}

// ─────────────────────────────────────────────
//  CLIENT
// ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
});

// ─────────────────────────────────────────────
//  REGISTER COMMANDS
// ─────────────────────────────────────────────
async function registerCommands() {
  const A = PermissionFlagsBits.Administrator;
  const commands = [
    new SlashCommandBuilder().setName('ar').setDescription('Manage autoresponders').setDefaultMemberPermissions(A)
      .addSubcommand(s => s.setName('add').setDescription('Add'))
      .addSubcommand(s => s.setName('edit').setDescription('Edit').addStringOption(o => o.setName('trigger').setDescription('Trigger').setRequired(true)))
      .addSubcommand(s => s.setName('delete').setDescription('Delete').addStringOption(o => o.setName('trigger').setDescription('Trigger').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List all')),

    new SlashCommandBuilder().setName('giveaway').setDescription('Start a giveaway').setDefaultMemberPermissions(A),

    new SlashCommandBuilder().setName('reroll').setDescription('Re-roll giveaway winners').setDefaultMemberPermissions(A)
      .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)),

    new SlashCommandBuilder().setName('queue').setDescription('Add a queue entry').setDefaultMemberPermissions(A)
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption(o => o.setName('bought').setDescription('What they bought').setRequired(true))
      .addStringOption(o => o.setName('paid').setDescription('What they paid with').setRequired(true)),

    new SlashCommandBuilder().setName('sticky').setDescription('Manage sticky messages').setDefaultMemberPermissions(A)
      .addSubcommand(s => s.setName('set').setDescription('Set sticky here'))
      .addSubcommand(s => s.setName('remove').setDescription('Remove sticky here')),

    new SlashCommandBuilder().setName('reply').setDescription('Reply to a modmail message').setDefaultMemberPermissions(A)
      .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Your reply').setRequired(true)),

    new SlashCommandBuilder().setName('addxp').setDescription('Add XP to a user').setDefaultMemberPermissions(A)
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount of XP').setRequired(true)),

    new SlashCommandBuilder().setName('level').setDescription("Check a user's level")
      .addUserOption(o => o.setName('user').setDescription('User (optional)')),

    new SlashCommandBuilder().setName('addpingjoin').setDescription('Add a ping-on-join channel').setDefaultMemberPermissions(A)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder().setName('removepingjoin').setDescription('Remove a ping-on-join channel').setDefaultMemberPermissions(A)
      .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),

    new SlashCommandBuilder().setName('listpingjoin').setDescription('List all ping-on-join channels').setDefaultMemberPermissions(A),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  for (const guildId of [GUILD_BOTS, GUILD_MAIN]) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands.map(c => c.toJSON()) });
      console.log(`✅ Commands registered in guild ${guildId}`);
    } catch (err) { console.error(`Error registering in ${guildId}:`, err); }
  }
}

// ─────────────────────────────────────────────
//  BOT READY
// ─────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Bot connected as ${client.user.tag}`);
  await registerCommands();
  await restoreGiveaways();
});

async function restoreGiveaways() {
  const active = db.prepare('SELECT * FROM giveaways WHERE finished = 0').all();
  for (const gw of active) {
    const remaining = gw.ends_at - Date.now();
    if (remaining <= 0) {
      await endGiveaway(gw.message_id);
    } else {
      setTimeout(() => endGiveaway(gw.message_id), remaining);
      console.log(`✅ Restored giveaway ${gw.message_id} — ends in ${Math.round(remaining / 1000)}s`);
    }
  }
}

// ─────────────────────────────────────────────
//  MEMBER JOIN
// ─────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  // Default nickname on join in main server
  if (member.guild.id === GUILD_MAIN) {
    try {
      await member.setNickname(`✾﹒﹒${member.user.username}`);
    } catch (err) { console.error('Nickname error on join:', err); }
  }

  // Ping on join (ghost ping — sends then deletes)
  const rows = db.prepare('SELECT channel_id FROM ping_on_join WHERE guild_id = ?').all(member.guild.id);
  for (const row of rows) {
    try {
      const ch  = await client.channels.fetch(row.channel_id);
      const msg = await ch.send(`<@${member.user.id}>`);
      setTimeout(() => msg.delete().catch(() => {}), 3000);
    } catch {}
  }
});

// ─────────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // DM → modmail both servers
  if (message.channel.type === 1) {
    try {
      const now   = new Date();
      const embed = new EmbedBuilder().setColor(0xFFFFFF)
        .addFields(
          { name: 'User',    value: `${message.author.tag}`, inline: true },
          { name: 'ID',      value: `\`${message.author.id}\``, inline: true },
          { name: 'Message', value: message.content || '*No text*', inline: false }
        )
        .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });

      for (const [gId, chId] of [[GUILD_BOTS, MODMAIL_CH], [GUILD_MAIN, MODMAIL_NEW]]) {
        try {
          const g  = await client.guilds.fetch(gId);
          const ch = await g.channels.fetch(chId);
          await ch.send({ embeds: [embed] });
        } catch {}
      }

      const confirm = new EmbedBuilder().setColor(0xFFFFFF)
        .setDescription(`your message has been received, we'll get back to you shortly 🤍`);
      await message.author.send({ embeds: [confirm] });
    } catch (err) { console.error('Modmail DM error:', err); }
    return;
  }

  const content  = message.content;
  const isPrefix = content.startsWith(PREFIX);

  if (isPrefix) {
    const args    = content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    if (command === 'reply') {
      const targetId = args.shift();
      const response = args.join(' ');
      if (!targetId || !response) { await message.reply('⚠️ Usage: `!reply <userID> <message>`'); return; }
      await handleReply(message.channel, message.author, targetId, response);
      return;
    }
    if (command === 'ar') {
      const sub = args.shift();
      if (sub === 'list')   { await listAR(message); return; }
      if (sub === 'delete') { await deleteAR(message, args.join(' ')); return; }
      if (sub === 'add' || sub === 'edit') { await message.reply('⚠️ Use `/ar add` or `/ar edit`.'); return; }
    }
    if (command === 'sticky') {
      const sub = args.shift();
      if (sub === 'remove') { await removeSticky(message.channel, message); return; }
      if (sub === 'set')    { await message.reply('⚠️ Use `/sticky set`.'); return; }
    }
  }

  // XP — only in main server
  if (message.guild?.id === GUILD_MAIN) {
    await handleXP(message);
  }

  // Autoresponders
  const lower = content.toLowerCase();
  const ars   = db.prepare('SELECT * FROM autoresponders').all();
  for (const ar of ars) {
    if (lower.includes(ar.trigger)) {
      if (ar.delete_msg) { try { await message.delete(); } catch {} }
      await message.channel.send(ar.response);
      break;
    }
  }

  // Sticky
  const sticky = db.prepare('SELECT * FROM sticky WHERE channel_id = ?').get(message.channel.id);
  if (sticky) {
    try { const old = await message.channel.messages.fetch(sticky.message_id); await old.delete(); } catch {}
    const sent = await message.channel.send(sticky.content);
    db.prepare('UPDATE sticky SET message_id = ? WHERE channel_id = ?').run(sent.id, message.channel.id);
  }
});

// ─────────────────────────────────────────────
//  XP SYSTEM
// ─────────────────────────────────────────────
async function handleXP(message) {
  const guildId = message.guild.id;
  const userId  = message.author.id;
  const now     = Date.now();

  const cooldown = db.prepare('SELECT last_xp FROM xp_cooldown WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (cooldown && now - cooldown.last_xp < 60000) return;

  db.prepare('INSERT OR REPLACE INTO xp_cooldown (guild_id, user_id, last_xp) VALUES (?, ?, ?)').run(guildId, userId, now);

  const xpGain = Math.floor(Math.random() * 11) + 15;

  let data = db.prepare('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!data) {
    db.prepare('INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, 0, 0)').run(guildId, userId);
    data = { xp: 0, level: 0 };
  }

  const newXP    = data.xp + xpGain;
  let   newLevel = data.level;
  let   leveledUp = false;

  while (newXP >= xpForLevel(newLevel + 1)) {
    newLevel++;
    leveledUp = true;
  }

  db.prepare('UPDATE levels SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?').run(newXP, newLevel, guildId, userId);

  if (leveledUp) {
    try {
      const guild  = await client.guilds.fetch(GUILD_MAIN);
      const member = await guild.members.fetch(userId);
      await handleLevelUp(member, newLevel);
    } catch (err) { console.error('Level up error:', err); }
  }
}

async function handleLevelUp(member, level) {
  const userId = member.user.id;

  // Announce level up
  try {
    const ch = await client.channels.fetch(LEVEL_CH);
    await ch.send(`🎉 <@${userId}> just reached **level ${level}**!`);
  } catch {}

  // Level 5 — give access role
  if (level === 5) {
    try { await member.roles.add(LEVEL_ROLES[5].all); } catch {}
  }

  // Levels 10, 25, 50 — give gender role and change nickname
  if ([10, 25, 50].includes(level)) {
    const gender = getGender(member);
    if (gender) {
      const roleId = LEVEL_ROLES[level][gender];
      if (roleId) { try { await member.roles.add(roleId); } catch {} }

      const prefix = LEVEL_NICKS[level][gender];
      if (prefix) {
        try { await member.setNickname(`${prefix}${member.user.username}`); } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
//  INTERACTIONS
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── SLASH COMMANDS ──
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;

    // /ar
    if (cmd === 'ar') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list')   { await listARSlash(interaction); return; }
      if (sub === 'delete') { await deleteARSlash(interaction, interaction.options.getString('trigger')); return; }
      if (sub === 'add' || sub === 'edit') {
        const trigger  = sub === 'edit' ? interaction.options.getString('trigger') : '';
        const existing = trigger ? db.prepare('SELECT * FROM autoresponders WHERE trigger = ?').get(trigger.toLowerCase()) : null;
        const modal    = new ModalBuilder().setCustomId(`ar_modal_${sub}`).setTitle(sub === 'add' ? 'Add Autoresponder' : 'Edit Autoresponder');
        const ti = new TextInputBuilder().setCustomId('ar_trigger').setLabel('Trigger word/phrase').setStyle(TextInputStyle.Short).setRequired(true);
        const ri = new TextInputBuilder().setCustomId('ar_response').setLabel('Response').setStyle(TextInputStyle.Paragraph).setRequired(true);
        const di = new TextInputBuilder().setCustomId('ar_delete').setLabel('Delete trigger message? (yes/no)').setStyle(TextInputStyle.Short).setRequired(true).setValue(existing?.delete_msg ? 'yes' : 'no');
        if (trigger) ti.setValue(trigger);
        if (existing) ri.setValue(existing.response);
        modal.addComponents(mrow(ti), mrow(ri), mrow(di));
        await interaction.showModal(modal);
        return;
      }
    }

    // /giveaway
    if (cmd === 'giveaway') {
      const modal = new ModalBuilder().setCustomId('gw_modal').setTitle('Giveaway Setup');
      modal.addComponents(
        mrow(minput('prize',     'Prize',                                     'Prize name',  100)),
        mrow(minput('winners',   'Number of winners (max 10)',                 '1',             2)),
        mrow(minput('duration',  'Duration in minutes (min 0.5, max 23040)',   'e.g. 60',       6)),
        mrow(minput('claimtime', 'Claim time in minutes (min 0.17, max 60)',   'e.g. 5',        4)),
        mrow(new TextInputBuilder().setCustomId('bonus_roles')
          .setLabel('Bonus entries: roleID:multiplier,roleID:multiplier')
          .setStyle(TextInputStyle.Short).setRequired(false)
          .setPlaceholder('e.g. 123456:2,789012:3'))
      );
      await interaction.showModal(modal);
      return;
    }

    // /reroll
    if (cmd === 'reroll') {
      const msgId = interaction.options.getString('message_id').trim();
      const gw    = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(msgId);
      if (!gw)          { await interaction.reply({ content: '⚠️ Giveaway not found.', ephemeral: true }); return; }
      if (!gw.finished) { await interaction.reply({ content: '⚠️ Giveaway is still active.', ephemeral: true }); return; }

      const participants = db.prepare('SELECT user_id, entries FROM giveaway_participants WHERE message_id = ?').all(msgId);
      const pool         = buildPool(participants);
      const winners      = pickMultiple(pool, gw.winners);
      const bonusRoles   = JSON.parse(gw.bonus_roles || '[]');

      try {
        const ch  = await client.channels.fetch(gw.channel_id);
        const msg = await ch.messages.fetch(msgId);
        await msg.edit({ embeds: [buildFinishedEmbed(gw, winners, participants.length, bonusRoles)] });
        const txt = winners.length
          ? `🔄 **Re-roll!** → ${winners.map(id => `<@${id}>`).join(', ')} 🎉`
          : '🔄 **Re-roll!** → No participants';
        await interaction.reply({ content: txt });
      } catch { await interaction.reply({ content: '⚠️ Could not edit message.', ephemeral: true }); }
      return;
    }

    // /queue
    if (cmd === 'queue') {
      const user   = interaction.options.getUser('user');
      const bought = interaction.options.getString('bought');
      const paid   = interaction.options.getString('paid');
      try {
        const ch  = await client.channels.fetch(QUEUE_CH);
        const msg = await ch.send(buildQueueText(user.id, bought, paid, 'ongoing'));
        await msg.edit({ components: [new ActionRowBuilder().addComponents(buildQueueSelect(msg.id))] });
        db.prepare('INSERT INTO queue_entries (message_id, user_id, bought, paid) VALUES (?, ?, ?, ?)').run(msg.id, user.id, bought, paid);
        await interaction.reply({ content: '✅ Queue entry added.', ephemeral: true });
      } catch (err) {
        console.error('Queue error:', err);
        await interaction.reply({ content: '⚠️ Could not send queue entry.', ephemeral: true });
      }
      return;
    }

    // /sticky
    if (cmd === 'sticky') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') {
        const modal = new ModalBuilder().setCustomId(`sticky_modal_${interaction.channel.id}`).setTitle('Set Sticky Message');
        modal.addComponents(mrow(new TextInputBuilder().setCustomId('sticky_content').setLabel('Sticky message content').setStyle(TextInputStyle.Paragraph).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
      if (sub === 'remove') { await removeSticky(interaction.channel, null, interaction); return; }
    }

    // /reply
    if (cmd === 'reply') {
      await handleReply(null, interaction.user, interaction.options.getString('userid'), interaction.options.getString('message'), interaction);
      return;
    }

    // /addxp
    if (cmd === 'addxp') {
      const user   = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      let data = db.prepare('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?').get(GUILD_MAIN, user.id);
      if (!data) {
        db.prepare('INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, 0, 0)').run(GUILD_MAIN, user.id);
        data = { xp: 0, level: 0 };
      }
      const newXP    = data.xp + amount;
      let   newLevel = data.level;
      let   leveledUp = false;
      while (newXP >= xpForLevel(newLevel + 1)) { newLevel++; leveledUp = true; }
      db.prepare('UPDATE levels SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?').run(newXP, newLevel, GUILD_MAIN, user.id);
      if (leveledUp) {
        try {
          const guild  = await client.guilds.fetch(GUILD_MAIN);
          const member = await guild.members.fetch(user.id);
          await handleLevelUp(member, newLevel);
        } catch {}
      }
      await interaction.reply({ content: `✅ Added **${amount} XP** to ${user.tag}. Total: **${newXP} XP** (Level ${newLevel})`, ephemeral: true });
      return;
    }

    // /level
    if (cmd === 'level') {
      const target = interaction.options.getUser('user') || interaction.user;
      const data   = db.prepare('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?').get(GUILD_MAIN, target.id);
      if (!data) { await interaction.reply({ content: `${target.tag} has no XP yet.`, ephemeral: true }); return; }
      const nextXP = xpForLevel(data.level + 1);
      const embed  = new EmbedBuilder().setColor(0xFFFFFF)
        .setTitle(`${target.username}'s level`)
        .addFields(
          { name: 'Level', value: `${data.level}`, inline: true },
          { name: 'XP',    value: `${data.xp} / ${nextXP}`, inline: true }
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // /addpingjoin
    if (cmd === 'addpingjoin') {
      const channel = interaction.options.getChannel('channel');
      db.prepare('INSERT OR IGNORE INTO ping_on_join (guild_id, channel_id) VALUES (?, ?)').run(interaction.guild.id, channel.id);
      await interaction.reply({ content: `✅ Added <#${channel.id}> to ping-on-join channels.`, ephemeral: true });
      return;
    }

    // /removepingjoin
    if (cmd === 'removepingjoin') {
      const channel = interaction.options.getChannel('channel');
      db.prepare('DELETE FROM ping_on_join WHERE guild_id = ? AND channel_id = ?').run(interaction.guild.id, channel.id);
      await interaction.reply({ content: `✅ Removed <#${channel.id}> from ping-on-join channels.`, ephemeral: true });
      return;
    }

    // /listpingjoin
    if (cmd === 'listpingjoin') {
      const rows = db.prepare('SELECT channel_id FROM ping_on_join WHERE guild_id = ?').all(interaction.guild.id);
      if (!rows.length) { await interaction.reply({ content: '⚠️ No ping-on-join channels set.', ephemeral: true }); return; }
      await interaction.reply({ content: `**Ping-on-join channels:**\n${rows.map(r => `<#${r.channel_id}>`).join('\n')}`, ephemeral: true });
      return;
    }
  }

  // ── MODALS ──
  if (interaction.isModalSubmit()) {

    // Giveaway
    if (interaction.customId === 'gw_modal') {
      const prize     = interaction.fields.getTextInputValue('prize').trim();
      const rawW      = interaction.fields.getTextInputValue('winners').trim();
      const rawDur    = interaction.fields.getTextInputValue('duration').trim();
      const rawClaim  = interaction.fields.getTextInputValue('claimtime').trim();
      const rawBonus  = interaction.fields.getTextInputValue('bonus_roles').trim();
      const winners   = clamp(parseInt(rawW, 10) || 1, 1, 10);
      const minutes   = parseFloat(rawDur);
      const claimMins = parseFloat(rawClaim);

      if (isNaN(minutes) || minutes < 0.5 || minutes > 23040) {
        await interaction.reply({ content: '⚠️ Invalid duration. Min 0.5, max 23040 minutes.', ephemeral: true }); return;
      }
      if (isNaN(claimMins) || claimMins < 0.17 || claimMins > 60) {
        await interaction.reply({ content: '⚠️ Invalid claim time. Min 0.17 (10s), max 60 minutes.', ephemeral: true }); return;
      }

      const bonusRoles = [];
      if (rawBonus) {
        for (const part of rawBonus.split(',')) {
          const [roleId, mult] = part.trim().split(':');
          if (roleId && mult) bonusRoles.push({ roleId: roleId.trim(), multiplier: parseInt(mult.trim(), 10) || 2 });
        }
      }

      const endsAt  = Date.now() + minutes * 60 * 1000;
      const hostedBy = interaction.user.id;
      const claimStr = claimMins < 1 ? `${Math.round(claimMins * 60)}s` : `${claimMins}m`;
      const guildId  = interaction.guild?.id || GUILD_BOTS;

      await interaction.reply({ content: '✅ Giveaway created!', ephemeral: true });

      const msg = await interaction.channel.send({
        content: '𝜗𝜚　**Giveaway** **!!**',
        embeds: [buildActiveGWEmbed({ prize, winners, endsAt, hostedBy, participantCount: 0, bonusRoles })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Secondary)
        )]
      });

      db.prepare('INSERT INTO giveaways (message_id, prize, winners, ends_at, hosted_by, claim_str, channel_id, guild_id, finished, bonus_roles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .run(msg.id, prize, winners, endsAt, hostedBy, claimStr, interaction.channel.id, guildId, JSON.stringify(bonusRoles));

      setTimeout(() => endGiveaway(msg.id), minutes * 60 * 1000);
      return;
    }

    // Sticky
    if (interaction.customId.startsWith('sticky_modal_')) {
      const channelId = interaction.customId.replace('sticky_modal_', '');
      const content   = interaction.fields.getTextInputValue('sticky_content');
      const existing  = db.prepare('SELECT * FROM sticky WHERE channel_id = ?').get(channelId);
      if (existing) {
        try { const m = await interaction.channel.messages.fetch(existing.message_id); await m.delete(); } catch {}
        db.prepare('DELETE FROM sticky WHERE channel_id = ?').run(channelId);
      }
      const sent = await interaction.channel.send(content);
      db.prepare('INSERT INTO sticky (channel_id, message_id, content) VALUES (?, ?, ?)').run(channelId, sent.id, content);
      await interaction.reply({ content: '✅ Sticky set.', ephemeral: true });
      return;
    }

    // AR
    if (interaction.customId.startsWith('ar_modal_')) {
      const trigger  = interaction.fields.getTextInputValue('ar_trigger').trim().toLowerCase();
      const response = interaction.fields.getTextInputValue('ar_response').trim();
      const delMsg   = interaction.fields.getTextInputValue('ar_delete').trim().toLowerCase() === 'yes' ? 1 : 0;
      db.prepare('INSERT OR REPLACE INTO autoresponders (trigger, response, delete_msg) VALUES (?, ?, ?)').run(trigger, response, delMsg);
      const mode = interaction.customId.includes('edit') ? 'updated' : 'added';
      await interaction.reply({ content: `✅ Autoresponder \`${trigger}\` ${mode}.`, ephemeral: true });
      return;
    }
  }

  // ── SELECT MENU — queue status ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('queue_')) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '⚠️ No permission.', ephemeral: true }); return;
    }
    const msgId  = interaction.customId.replace('queue_', '');
    const status = interaction.values[0];
    const entry  = db.prepare('SELECT * FROM queue_entries WHERE message_id = ?').get(msgId);
    if (!entry) { await interaction.reply({ content: '⚠️ Queue entry not found.', ephemeral: true }); return; }
    try {
      const ch  = await client.channels.fetch(QUEUE_CH);
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({ content: buildQueueText(entry.user_id, entry.bought, entry.paid, status), components: [new ActionRowBuilder().addComponents(buildQueueSelect(msgId))] });
      await interaction.reply({ content: `✅ Status updated to **${status}**.`, ephemeral: true });
    } catch { await interaction.reply({ content: '⚠️ Could not update.', ephemeral: true }); }
    return;
  }

  // ── BUTTON — giveaway enter ──
  if (interaction.isButton() && interaction.customId === 'gw_enter') {
    const gw = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(interaction.message.id);
    if (!gw || gw.finished) { await interaction.reply({ content: '⚠️ This giveaway has ended.', ephemeral: true }); return; }

    const uid      = interaction.user.id;
    const existing = db.prepare('SELECT 1 FROM giveaway_participants WHERE message_id = ? AND user_id = ?').get(gw.message_id, uid);
    if (existing)  { await interaction.reply({ content: '⚠️ You are already entered!', ephemeral: true }); return; }

    const bonusRoles = JSON.parse(gw.bonus_roles || '[]');
    let entries = 1;
    if (interaction.member && bonusRoles.length > 0) {
      for (const br of bonusRoles) {
        if (interaction.member.roles.cache.has(br.roleId)) {
          entries = Math.max(entries, br.multiplier);
        }
      }
    }

    db.prepare('INSERT INTO giveaway_participants (message_id, user_id, entries) VALUES (?, ?, ?)').run(gw.message_id, uid, entries);
    const count = db.prepare('SELECT COUNT(*) as c FROM giveaway_participants WHERE message_id = ?').get(gw.message_id).c;

    try {
      await interaction.message.edit({
        embeds: [buildActiveGWEmbed({ prize: gw.prize, winners: gw.winners, endsAt: gw.ends_at, hostedBy: gw.hosted_by, participantCount: count, bonusRoles })]
      });
    } catch {}

    const entryTxt = entries > 1 ? ` with **${entries}x entries**` : '';
    await interaction.reply({ content: `🎉 You entered for **${gw.prize}**${entryTxt}! Good luck 🍀`, ephemeral: true });
  }
});

// ─────────────────────────────────────────────
//  GIVEAWAY HELPERS
// ─────────────────────────────────────────────
function buildActiveGWEmbed({ prize, winners, endsAt, hostedBy, participantCount = 0, bonusRoles = [] }) {
  const now      = new Date();
  let bonusTxt   = '';
  for (const br of bonusRoles) bonusTxt += `\n+<@&${br.roleId}> x${br.multiplier} entries`;
  return new EmbedBuilder().setColor(0xFFFFFF)
    .setDescription(
      `**${prize}**\n` +
      `End: <t:${Math.floor(endsAt / 1000)}:R>\n` +
      `Hosted by <@${hostedBy}>\n` +
      `Participants: ${participantCount}` +
      bonusTxt
    )
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

function buildFinishedEmbed(gw, winners, participantCount, bonusRoles = []) {
  const w        = winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No participants';
  const now      = new Date();
  let bonusTxt   = '';
  for (const br of bonusRoles) bonusTxt += `\n+<@&${br.roleId}> x${br.multiplier} entries`;
  return new EmbedBuilder().setColor(0xFFFFFF)
    .setDescription(
      `**${gw.prize}**\n` +
      `Winner${gw.winners > 1 ? 's' : ''}: ${w}\n` +
      `Hosted by <@${gw.hosted_by}>\n` +
      `Participants: ${participantCount}` +
      bonusTxt
    )
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

async function endGiveaway(messageId) {
  const gw = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(messageId);
  if (!gw || gw.finished) return;
  db.prepare('UPDATE giveaways SET finished = 1 WHERE message_id = ?').run(messageId);

  const participants = db.prepare('SELECT user_id, entries FROM giveaway_participants WHERE message_id = ?').all(messageId);
  const pool         = buildPool(participants);
  const winners      = pickMultiple(pool, gw.winners);
  const bonusRoles   = JSON.parse(gw.bonus_roles || '[]');

  try {
    const ch  = await client.channels.fetch(gw.channel_id);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({
      content: '𝜗𝜚　**Giveaway** **!!**',
      embeds: [buildFinishedEmbed(gw, winners, participants.length, bonusRoles)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Secondary).setDisabled(true)
      )]
    });
    if (winners.length) {
      await ch.send(`ೀ. . .﹒ congratulation's ${winners.map(id => `<@${id}>`).join(', ')} **!!**, you won **(${gw.prize})**. You have ${gw.claim_str} to claim.\n-# claim in tickets`);
    } else {
      await ch.send(`No one entered the giveaway for **${gw.prize}**. 😔`);
    }
  } catch (err) { console.error('Error ending giveaway:', err); }
}

// ─────────────────────────────────────────────
//  MODMAIL REPLY
// ─────────────────────────────────────────────
async function handleReply(channel, sender, targetId, response, interaction = null) {
  try {
    const targetUser = await client.users.fetch(targetId);
    const now        = new Date();
    const replyEmbed = new EmbedBuilder().setColor(0xFFFFFF)
      .setDescription(`"${response}"`)
      .setFooter({ text: `sent by ${sender.tag} · ${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
    const followup = new EmbedBuilder().setColor(0xFFFFFF)
      .setDescription(`-# if your question wasn't resolved or you need anything else, feel free to message again or open a ticket in the server.`);
    await targetUser.send({ embeds: [replyEmbed] });
    await targetUser.send({ embeds: [followup] });
    const confirm = new EmbedBuilder().setColor(0xFFFFFF).setDescription(`✅ Reply sent to **${targetUser.tag}**.`);
    if (interaction) await interaction.reply({ embeds: [confirm], ephemeral: true });
    else await channel?.send({ embeds: [confirm] });
  } catch (err) {
    console.error('Reply error:', err);
    if (interaction) await interaction.reply({ content: '⚠️ Could not send reply.', ephemeral: true });
    else await channel?.send('⚠️ Could not send reply.');
  }
}

// ─────────────────────────────────────────────
//  AR HELPERS
// ─────────────────────────────────────────────
async function listAR(message) {
  const ars = db.prepare('SELECT trigger FROM autoresponders').all();
  if (!ars.length) { await message.reply('⚠️ No autoresponders set.'); return; }
  await message.reply(`**Autoresponders:**\n${ars.map((a, i) => `${i + 1}. \`${a.trigger}\``).join('\n')}`);
}
async function listARSlash(interaction) {
  const ars = db.prepare('SELECT trigger FROM autoresponders').all();
  if (!ars.length) { await interaction.reply({ content: '⚠️ No autoresponders set.', ephemeral: true }); return; }
  await interaction.reply({ content: `**Autoresponders:**\n${ars.map((a, i) => `${i + 1}. \`${a.trigger}\``).join('\n')}`, ephemeral: true });
}
async function deleteAR(message, trigger) {
  if (!trigger) { await message.reply('⚠️ Provide a trigger.'); return; }
  const c = db.prepare('DELETE FROM autoresponders WHERE trigger = ?').run(trigger.toLowerCase()).changes;
  await message.reply(c ? `✅ Deleted \`${trigger}\`.` : `⚠️ Not found.`);
}
async function deleteARSlash(interaction, trigger) {
  const c = db.prepare('DELETE FROM autoresponders WHERE trigger = ?').run(trigger.toLowerCase()).changes;
  await interaction.reply({ content: c ? `✅ Deleted \`${trigger}\`.` : `⚠️ Not found.`, ephemeral: true });
}

// ─────────────────────────────────────────────
//  STICKY HELPERS
// ─────────────────────────────────────────────
async function removeSticky(channel, message = null, interaction = null) {
  const sticky = db.prepare('SELECT * FROM sticky WHERE channel_id = ?').get(channel.id);
  if (sticky) {
    try { const m = await channel.messages.fetch(sticky.message_id); await m.delete(); } catch {}
    db.prepare('DELETE FROM sticky WHERE channel_id = ?').run(channel.id);
    if (interaction) await interaction.reply({ content: '✅ Sticky removed.', ephemeral: true });
    else await message?.reply('✅ Sticky removed.');
  } else {
    if (interaction) await interaction.reply({ content: '⚠️ No sticky in this channel.', ephemeral: true });
    else await message?.reply('⚠️ No sticky in this channel.');
  }
}

// ─────────────────────────────────────────────
//  QUEUE HELPERS
// ─────────────────────────────────────────────
function buildQueueText(userId, bought, paid, status) {
  return (
    `𝜗𝜚﹒﹒　　<@${userId}> ◟  ͜⠀\n` +
    `　　　　　　 ⁺ . ♡ ⁺ .\n` +
    `𝜗𝜚 _bought_﹕ ${bought}\n` +
    `﹒ pa**id** wi**th**﹕ ${paid}\n` +
    `𝜗𝜚 _status_﹕ **__${status}__**\n` +
    `　　　　　　 ⁺ . ♡ ⁺ .`
  );
}

function buildQueueSelect(msgId) {
  return new StringSelectMenuBuilder().setCustomId(`queue_${msgId}`).setPlaceholder('Change status')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Ongoing').setValue('ongoing'),
      new StringSelectMenuOptionBuilder().setLabel('Noted').setValue('noted'),
      new StringSelectMenuOptionBuilder().setLabel('Done').setValue('done')
    );
}

// ─────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────
function buildPool(participants) {
  const pool = [];
  for (const p of participants) {
    for (let i = 0; i < (p.entries || 1); i++) pool.push(p.user_id);
  }
  return pool;
}

function pickMultiple(pool, count) {
  if (!pool || pool.length === 0) return [];
  const p = [...pool], seen = new Set(), result = [];
  let attempts = 0;
  while (result.length < Math.min(count, new Set(p).size) && attempts < 1000) {
    const pick = p[Math.floor(Math.random() * p.length)];
    if (!seen.has(pick)) { seen.add(pick); result.push(pick); }
    attempts++;
  }
  return result;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function mrow(c) { return new ActionRowBuilder().addComponents(c); }
function minput(id, label, placeholder, maxLength) {
  return new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(TextInputStyle.Short).setPlaceholder(placeholder)
    .setRequired(true).setMaxLength(maxLength);
}

client.login(process.env.TOKEN);
