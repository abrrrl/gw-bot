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
    finished INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS giveaway_participants (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
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
const CLIENT_ID   = process.env.CLIENT_ID;

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
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  for (const guildId of [GUILD_BOTS, GUILD_MAIN]) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands.map(c => c.toJSON()) });
      console.log(`✅ Commands registered in guild ${guildId}`);
    } catch (err) { console.error(`Error registering in ${guildId}:`, err.message); }
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
      console.log(`✅ Restored giveaway ${gw.message_id}`);
    }
  }
}

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
//  INTERACTIONS
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

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
        mrow(minput('claimtime', 'Claim time in minutes (min 0.17, max 60)',   'e.g. 5',        4))
      );
      await interaction.showModal(modal);
      return;
    }

    // /reroll
    if (cmd === 'reroll') {
      const msgId = interaction.options.getString('message_id').trim();
      const gw    = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(msgId);
      if (!gw)          { await interaction.reply({ content: '⚠️ Giveaway not found.', flags: 64 }); return; }
      if (!gw.finished) { await interaction.reply({ content: '⚠️ Giveaway is still active.', flags: 64 }); return; }

      const participants = db.prepare('SELECT user_id FROM giveaway_participants WHERE message_id = ?').all(msgId).map(r => r.user_id);
      const winners      = pickMultiple(participants, gw.winners);

      try {
        const ch  = await client.channels.fetch(gw.channel_id);
        const msg = await ch.messages.fetch(msgId);
        await msg.edit({ embeds: [buildFinishedEmbed(gw, winners, participants.length)] });
        const txt = winners.length
          ? `🔄 **Re-roll!** → ${winners.map(id => `<@${id}>`).join(', ')} 🎉`
          : '🔄 **Re-roll!** → No participants';
        await interaction.reply({ content: txt });
      } catch { await interaction.reply({ content: '⚠️ Could not edit message.', flags: 64 }); }
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
        await interaction.reply({ content: '✅ Queue entry added.', flags: 64 });
      } catch (err) {
        console.error('Queue error:', err);
        await interaction.reply({ content: '⚠️ Could not send queue entry.', flags: 64 });
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
  }

  // ── MODALS ──
  if (interaction.isModalSubmit()) {

    // Giveaway
    if (interaction.customId === 'gw_modal') {
      const prize     = interaction.fields.getTextInputValue('prize').trim();
      const rawW      = interaction.fields.getTextInputValue('winners').trim();
      const rawDur    = interaction.fields.getTextInputValue('duration').trim();
      const rawClaim  = interaction.fields.getTextInputValue('claimtime').trim();
      const winners   = clamp(parseInt(rawW, 10) || 1, 1, 10);
      const minutes   = parseFloat(rawDur);
      const claimMins = parseFloat(rawClaim);

      if (isNaN(minutes) || minutes < 0.5 || minutes > 23040) {
        await interaction.reply({ content: '⚠️ Invalid duration. Min 0.5, max 23040 minutes.', flags: 64 }); return;
      }
      if (isNaN(claimMins) || claimMins < 0.17 || claimMins > 60) {
        await interaction.reply({ content: '⚠️ Invalid claim time. Min 0.17 (10s), max 60 minutes.', flags: 64 }); return;
      }

      const endsAt   = Date.now() + minutes * 60 * 1000;
      const hostedBy = interaction.user.id;
      const claimStr = claimMins < 1 ? `${Math.round(claimMins * 60)}s` : `${claimMins}m`;

      await interaction.reply({ content: '✅ Giveaway created!', flags: 64 });

      const msg = await interaction.channel.send({
        content: '𝜗𝜚　**Giveaway** **!!**',
        embeds: [buildActiveGWEmbed({ prize, winners, endsAt, hostedBy, participantCount: 0 })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Secondary)
        )]
      });

      db.prepare('INSERT INTO giveaways (message_id, prize, winners, ends_at, hosted_by, claim_str, channel_id, finished) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
        .run(msg.id, prize, winners, endsAt, hostedBy, claimStr, interaction.channel.id);

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
      await interaction.reply({ content: '✅ Sticky set.', flags: 64 });
      return;
    }

    // AR
    if (interaction.customId.startsWith('ar_modal_')) {
      const trigger  = interaction.fields.getTextInputValue('ar_trigger').trim().toLowerCase();
      const response = interaction.fields.getTextInputValue('ar_response').trim();
      const delMsg   = interaction.fields.getTextInputValue('ar_delete').trim().toLowerCase() === 'yes' ? 1 : 0;
      db.prepare('INSERT OR REPLACE INTO autoresponders (trigger, response, delete_msg) VALUES (?, ?, ?)').run(trigger, response, delMsg);
      const mode = interaction.customId.includes('edit') ? 'updated' : 'added';
      await interaction.reply({ content: `✅ Autoresponder \`${trigger}\` ${mode}.`, flags: 64 });
      return;
    }
  }

  // ── SELECT MENU — queue status ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('queue_')) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '⚠️ No permission.', flags: 64 }); return;
    }
    const msgId  = interaction.customId.replace('queue_', '');
    const status = interaction.values[0];
    const entry  = db.prepare('SELECT * FROM queue_entries WHERE message_id = ?').get(msgId);
    if (!entry) { await interaction.reply({ content: '⚠️ Queue entry not found.', flags: 64 }); return; }
    try {
      const ch  = await client.channels.fetch(QUEUE_CH);
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({ content: buildQueueText(entry.user_id, entry.bought, entry.paid, status), components: [new ActionRowBuilder().addComponents(buildQueueSelect(msgId))] });
      await interaction.reply({ content: `✅ Status updated to **${status}**.`, flags: 64 });
    } catch { await interaction.reply({ content: '⚠️ Could not update.', flags: 64 }); }
    return;
  }

  // ── BUTTON — giveaway enter ──
  if (interaction.isButton() && interaction.customId === 'gw_enter') {
    const gw = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(interaction.message.id);
    if (!gw || gw.finished) { await interaction.reply({ content: '⚠️ This giveaway has ended.', flags: 64 }); return; }

    const uid      = interaction.user.id;
    const existing = db.prepare('SELECT 1 FROM giveaway_participants WHERE message_id = ? AND user_id = ?').get(gw.message_id, uid);
    if (existing)  { await interaction.reply({ content: '⚠️ You are already entered!', flags: 64 }); return; }

    db.prepare('INSERT INTO giveaway_participants (message_id, user_id) VALUES (?, ?)').run(gw.message_id, uid);
    const count = db.prepare('SELECT COUNT(*) as c FROM giveaway_participants WHERE message_id = ?').get(gw.message_id).c;

    try {
      await interaction.message.edit({
        embeds: [buildActiveGWEmbed({ prize: gw.prize, winners: gw.winners, endsAt: gw.ends_at, hostedBy: gw.hosted_by, participantCount: count })]
      });
    } catch {}

    await interaction.reply({ content: `🎉 You entered for **${gw.prize}**! Good luck 🍀`, flags: 64 });
  }
});

// ─────────────────────────────────────────────
//  GIVEAWAY HELPERS
// ─────────────────────────────────────────────
function buildActiveGWEmbed({ prize, winners, endsAt, hostedBy, participantCount = 0 }) {
  const now = new Date();
  return new EmbedBuilder().setColor(0xFFFFFF)
    .setDescription(
      `**${prize}**\n` +
      `End: <t:${Math.floor(endsAt / 1000)}:R>\n` +
      `Hosted by <@${hostedBy}>\n` +
      `Participants: ${participantCount}`
    )
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

function buildFinishedEmbed(gw, winners, participantCount) {
  const w   = winners.length ? winners.map(id => `<@${id}>`).join(', ') : 'No participants';
  const now = new Date();
  return new EmbedBuilder().setColor(0xFFFFFF)
    .setDescription(
      `**${gw.prize}**\n` +
      `Winner${gw.winners > 1 ? 's' : ''}: ${w}\n` +
      `Hosted by <@${gw.hosted_by}>\n` +
      `Participants: ${participantCount}`
    )
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

async function endGiveaway(messageId) {
  const gw = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(messageId);
  if (!gw || gw.finished) return;
  db.prepare('UPDATE giveaways SET finished = 1 WHERE message_id = ?').run(messageId);

  const participants = db.prepare('SELECT user_id FROM giveaway_participants WHERE message_id = ?').all(messageId).map(r => r.user_id);
  const winners      = pickMultiple(participants, gw.winners);

  try {
    const ch  = await client.channels.fetch(gw.channel_id);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({
      content: '𝜗𝜚　**Giveaway** **!!**',
      embeds: [buildFinishedEmbed(gw, winners, participants.length)],
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
    if (interaction) await interaction.reply({ embeds: [confirm], flags: 64 });
    else await channel?.send({ embeds: [confirm] });
  } catch (err) {
    console.error('Reply error:', err);
    if (interaction) await interaction.reply({ content: '⚠️ Could not send reply.', flags: 64 });
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
  if (!ars.length) { await interaction.reply({ content: '⚠️ No autoresponders set.', flags: 64 }); return; }
  await interaction.reply({ content: `**Autoresponders:**\n${ars.map((a, i) => `${i + 1}. \`${a.trigger}\``).join('\n')}`, flags: 64 });
}
async function deleteAR(message, trigger) {
  if (!trigger) { await message.reply('⚠️ Provide a trigger.'); return; }
  const c = db.prepare('DELETE FROM autoresponders WHERE trigger = ?').run(trigger.toLowerCase()).changes;
  await message.reply(c ? `✅ Deleted \`${trigger}\`.` : `⚠️ Not found.`);
}
async function deleteARSlash(interaction, trigger) {
  const c = db.prepare('DELETE FROM autoresponders WHERE trigger = ?').run(trigger.toLowerCase()).changes;
  await interaction.reply({ content: c ? `✅ Deleted \`${trigger}\`.` : `⚠️ Not found.`, flags: 64 });
}

// ─────────────────────────────────────────────
//  STICKY HELPERS
// ─────────────────────────────────────────────
async function removeSticky(channel, message = null, interaction = null) {
  const sticky = db.prepare('SELECT * FROM sticky WHERE channel_id = ?').get(channel.id);
  if (sticky) {
    try { const m = await channel.messages.fetch(sticky.message_id); await m.delete(); } catch {}
    db.prepare('DELETE FROM sticky WHERE channel_id = ?').run(channel.id);
    if (interaction) await interaction.reply({ content: '✅ Sticky removed.', flags: 64 });
    else await message?.reply('✅ Sticky removed.');
  } else {
    if (interaction) await interaction.reply({ content: '⚠️ No sticky in this channel.', flags: 64 });
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
function pickMultiple(pool, count) {
  if (!pool || pool.length === 0) return [];
  const arr = [...pool], seen = new Set(), result = [];
  let attempts = 0;
  while (result.length < Math.min(count, new Set(arr).size) && attempts < 1000) {
    const pick = arr[Math.floor(Math.random() * arr.length)];
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
