const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');

require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

const PREFIX     = '!';
const QUEUE_CH   = '1291958364288450613';
const MODMAIL_CH = '1500722506611294259';
const GUILD_ID   = process.env.GUILD_ID;
const CLIENT_ID  = process.env.CLIENT_ID;

const autoresponders = new Map();
const giveaways      = new Map();
const stickyMessages = new Map();
const queueEntries   = new Map(); // messageId → { user, bought, paid }

// ─────────────────────────────────────────────
//  REGISTRO DE COMANDOS
// ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('ar').setDescription('Manage autoresponders')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('add').setDescription('Add an autoresponder'))
      .addSubcommand(s => s.setName('edit').setDescription('Edit an autoresponder')
        .addStringOption(o => o.setName('trigger').setDescription('Trigger to edit').setRequired(true)))
      .addSubcommand(s => s.setName('delete').setDescription('Delete an autoresponder')
        .addStringOption(o => o.setName('trigger').setDescription('Trigger to delete').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List all autoresponders')),

    new SlashCommandBuilder()
      .setName('giveaway').setDescription('Start a giveaway')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('reroll').setDescription('Re-roll giveaway winners')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)),

    new SlashCommandBuilder()
      .setName('queue').setDescription('Add a queue entry')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
      .addStringOption(o => o.setName('bought').setDescription('What they bought').setRequired(true))
      .addStringOption(o => o.setName('paid').setDescription('What they paid with').setRequired(true)),

    new SlashCommandBuilder()
      .setName('sticky').setDescription('Manage sticky messages')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('set').setDescription('Set sticky in this channel'))
      .addSubcommand(s => s.setName('remove').setDescription('Remove sticky from this channel')),

    new SlashCommandBuilder()
      .setName('reply').setDescription('Reply to a modmail message')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => o.setName('userid').setDescription('User ID to reply to').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Your reply').setRequired(true)),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Commands registered.');
  } catch (err) { console.error('Error registering commands:', err); }
}

client.once('clientReady', () => {
  console.log(`✅ Bot connected as ${client.user.tag}`);
  registerCommands();
});

// ─────────────────────────────────────────────
//  MENSAJES
// ─────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // DM → modmail
  if (message.channel.type === 1) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const ch    = await guild.channels.fetch(MODMAIL_CH);
      const now   = new Date();

      const embed = new EmbedBuilder()
        .setColor(0xFFFFFF)
        .addFields(
          { name: 'User', value: `${message.author.tag}`, inline: true },
          { name: 'ID',   value: `\`${message.author.id}\``, inline: true },
          { name: 'Message', value: message.content || '*No text*', inline: false }
        )
        .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });

      await ch.send({ embeds: [embed] });

      const confirm = new EmbedBuilder()
        .setColor(0xFFFFFF)
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
      if (sub === 'add' || sub === 'edit') {
        await message.reply('⚠️ Use the slash command `/ar add` or `/ar edit` instead.');
        return;
      }
    }

    if (command === 'sticky') {
      const sub = args.shift();
      if (sub === 'remove') { await removeSticky(message.channel, message); return; }
      if (sub === 'set') { await message.reply('⚠️ Use `/sticky set` instead.'); return; }
    }
  }

  // Autoresponders
  const lower = content.toLowerCase();
  for (const [trigger, data] of autoresponders) {
    if (lower.includes(trigger.toLowerCase())) {
      if (data.deleteMsg) { try { await message.delete(); } catch {} }
      await message.channel.send(data.response);
      break;
    }
  }

  // Sticky
  if (stickyMessages.has(message.channel.id)) {
    const sticky = stickyMessages.get(message.channel.id);
    try { const old = await message.channel.messages.fetch(sticky.messageId); await old.delete(); } catch {}
    const sent = await message.channel.send(sticky.content);
    sticky.messageId = sent.id;
  }
});

// ─────────────────────────────────────────────
//  INTERACTIONS
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // /ar
    if (commandName === 'ar') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list')   { await listARSlash(interaction); return; }
      if (sub === 'delete') { await deleteARSlash(interaction, interaction.options.getString('trigger')); return; }
      if (sub === 'add' || sub === 'edit') {
        const trigger  = sub === 'edit' ? interaction.options.getString('trigger') : '';
        const existing = trigger ? autoresponders.get(trigger.toLowerCase()) : null;
        const modal    = new ModalBuilder().setCustomId(`ar_modal_${sub}`).setTitle(sub === 'add' ? 'Add Autoresponder' : 'Edit Autoresponder');
        const ti = new TextInputBuilder().setCustomId('ar_trigger').setLabel('Trigger word/phrase').setStyle(TextInputStyle.Short).setRequired(true);
        const ri = new TextInputBuilder().setCustomId('ar_response').setLabel('Response').setStyle(TextInputStyle.Paragraph).setRequired(true);
        const di = new TextInputBuilder().setCustomId('ar_delete').setLabel('Delete trigger message? (yes/no)').setStyle(TextInputStyle.Short).setRequired(true).setValue(existing?.deleteMsg ? 'yes' : 'no');
        if (trigger) ti.setValue(trigger);
        if (existing) ri.setValue(existing.response);
        modal.addComponents(mrow(ti), mrow(ri), mrow(di));
        await interaction.showModal(modal);
        return;
      }
    }

    // /giveaway → UN SOLO MODAL de 5 campos
    if (commandName === 'giveaway') {
      const modal = new ModalBuilder().setCustomId('gw_modal').setTitle('Giveaway Setup');
      modal.addComponents(
        mrow(minput('prize',     'Prize',                              'Prize name',            100)),
        mrow(minput('winners',   'Number of winners (max 10)',         '1',                       2)),
        mrow(minput('duration',  'Duration in minutes (min 0.5, max 23040)', 'e.g. 60',           6)),
        mrow(minput('claimtime', 'Claim time in minutes (min 0.17, max 60)', 'e.g. 5',            4))
      );
      await interaction.showModal(modal);
      return;
    }

    // /reroll
    if (commandName === 'reroll') {
      const msgId = interaction.options.getString('message_id').trim();
      const gw    = giveaways.get(msgId);
      if (!gw)          { await interaction.reply({ content: '⚠️ Giveaway not found.', ephemeral: true }); return; }
      if (!gw.finished) { await interaction.reply({ content: '⚠️ Giveaway still active.', ephemeral: true }); return; }

      gw.lastWinners = pickMultiple(gw.participants, gw.winners);
      try {
        const ch  = await client.channels.fetch(gw.channelId);
        const msg = await ch.messages.fetch(msgId);
        await msg.edit({ embeds: [buildFinishedEmbed(gw)] });
        const txt = gw.lastWinners.length
          ? `🔄 **Re-roll!** → ${gw.lastWinners.map(id => `<@${id}>`).join(', ')} 🎉`
          : '🔄 **Re-roll!** → No participants';
        await interaction.reply({ content: txt });
      } catch { await interaction.reply({ content: '⚠️ Could not edit message.', ephemeral: true }); }
      return;
    }

    // /queue
    if (commandName === 'queue') {
      const user   = interaction.options.getUser('user');
      const bought = interaction.options.getString('bought');
      const paid   = interaction.options.getString('paid');

      const text =
        `𝜗𝜚﹒﹒　　<@${user.id}> ◟  ͜⠀\n` +
        `　　　　　　 ⁺ . ♡ ⁺ .\n` +
        `𝜗𝜚 _bought_﹕ ${bought}\n` +
        `﹒ pa**id** wi**th**﹕ ${paid}\n` +
        `𝜗𝜚 _status_﹕ **__ongoing__**\n` +
        `　　　　　　 ⁺ . ♡ ⁺ .`;

      try {
        const ch  = await client.channels.fetch(QUEUE_CH);
        const msg = await ch.send(text);

        const select = new StringSelectMenuBuilder()
          .setCustomId(`queue_${msg.id}`)
          .setPlaceholder('Change status')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Ongoing').setValue('ongoing'),
            new StringSelectMenuOptionBuilder().setLabel('Noted').setValue('noted'),
            new StringSelectMenuOptionBuilder().setLabel('Done').setValue('done')
          );

        await msg.edit({ components: [new ActionRowBuilder().addComponents(select)] });
        queueEntries.set(msg.id, { userId: user.id, username: user.username, bought, paid });
        await interaction.reply({ content: '✅ Queue entry added.', ephemeral: true });
      } catch (err) {
        console.error('Queue error:', err);
        await interaction.reply({ content: '⚠️ Could not send queue entry.', ephemeral: true });
      }
      return;
    }

    // /sticky
    if (commandName === 'sticky') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') {
        const modal = new ModalBuilder().setCustomId(`sticky_modal_${interaction.channel.id}`).setTitle('Set Sticky Message');
        modal.addComponents(mrow(new TextInputBuilder().setCustomId('sticky_content').setLabel('Sticky message content').setStyle(TextInputStyle.Paragraph).setRequired(true)));
        await interaction.showModal(modal);
        return;
      }
      if (sub === 'remove') {
        await removeSticky(interaction.channel, null, interaction);
        return;
      }
    }

    // /reply
    if (commandName === 'reply') {
      const targetId = interaction.options.getString('userid');
      const response = interaction.options.getString('message');
      await handleReply(null, interaction.user, targetId, response, interaction);
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
        await interaction.reply({ content: '⚠️ Invalid duration. Min 0.5, max 23040 minutes.', ephemeral: true }); return;
      }
      if (isNaN(claimMins) || claimMins < 0.17 || claimMins > 60) {
        await interaction.reply({ content: '⚠️ Invalid claim time. Min 0.17 (10s), max 60 minutes.', ephemeral: true }); return;
      }

      const endsAt   = new Date(Date.now() + minutes * 60 * 1000);
      const hostedBy = interaction.user.id;
      const claimStr = claimMins < 1 ? `${Math.round(claimMins * 60)}s` : `${claimMins}m`;

      await interaction.reply({ content: '✅ Giveaway created!', ephemeral: true });

      const msg = await interaction.channel.send({
        content: '𝜗𝜚　**Giveaway** **!!**',
        embeds: [buildActiveGWEmbed({ prize, winners, endsAt, hostedBy })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Secondary)
        )]
      });

      giveaways.set(msg.id, {
        prize, winners, endsAt, hostedBy, claimStr,
        channelId: interaction.channel.id,
        messageId: msg.id,
        participants: new Set(),
        lastWinners: [],
        finished: false
      });

      setTimeout(() => endGiveaway(msg.id), minutes * 60 * 1000);
      return;
    }

    // Sticky
    if (interaction.customId.startsWith('sticky_modal_')) {
      const channelId = interaction.customId.replace('sticky_modal_', '');
      const content   = interaction.fields.getTextInputValue('sticky_content');
      if (stickyMessages.has(channelId)) {
        const old = stickyMessages.get(channelId);
        try { const m = await interaction.channel.messages.fetch(old.messageId); await m.delete(); } catch {}
      }
      const sent = await interaction.channel.send(content);
      stickyMessages.set(channelId, { messageId: sent.id, content });
      await interaction.reply({ content: '✅ Sticky set.', ephemeral: true });
      return;
    }

    // AR
    if (interaction.customId.startsWith('ar_modal_')) {
      const trigger  = interaction.fields.getTextInputValue('ar_trigger').trim().toLowerCase();
      const response = interaction.fields.getTextInputValue('ar_response').trim();
      const delMsg   = interaction.fields.getTextInputValue('ar_delete').trim().toLowerCase() === 'yes';
      autoresponders.set(trigger, { response, deleteMsg: delMsg });
      const mode = interaction.customId.includes('edit') ? 'updated' : 'added';
      await interaction.reply({ content: `✅ Autoresponder \`${trigger}\` ${mode}.`, ephemeral: true });
      return;
    }
  }

  // ── SELECT MENU (queue status) ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('queue_')) {
    // Solo admins
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '⚠️ You do not have permission to change the status.', ephemeral: true });
      return;
    }

    const msgId  = interaction.customId.replace('queue_', '');
    const status = interaction.values[0];
    const entry  = queueEntries.get(msgId);
    if (!entry) { await interaction.reply({ content: '⚠️ Queue entry not found.', ephemeral: true }); return; }

    const statusLabel = `**__${status}__**`;
    const text =
      `𝜗𝜚﹒﹒　　<@${entry.userId}> ◟  ͜⠀\n` +
      `　　　　　　 ⁺ . ♡ ⁺ .\n` +
      `𝜗𝜚 _bought_﹕ ${entry.bought}\n` +
      `﹒ pa**id** wi**th**﹕ ${entry.paid}\n` +
      `𝜗𝜚 _status_﹕ ${statusLabel}\n` +
      `　　　　　　 ⁺ . ♡ ⁺ .`;

    const select = new StringSelectMenuBuilder()
      .setCustomId(`queue_${msgId}`)
      .setPlaceholder('Change status')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Ongoing').setValue('ongoing'),
        new StringSelectMenuOptionBuilder().setLabel('Noted').setValue('noted'),
        new StringSelectMenuOptionBuilder().setLabel('Done').setValue('done')
      );

    try {
      const ch  = await client.channels.fetch(QUEUE_CH);
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({ content: text, components: [new ActionRowBuilder().addComponents(select)] });
      await interaction.reply({ content: `✅ Status updated to **${status}**.`, ephemeral: true });
    } catch { await interaction.reply({ content: '⚠️ Could not update.', ephemeral: true }); }
    return;
  }

  // ── BUTTON (giveaway enter) ──
  if (interaction.isButton() && interaction.customId === 'gw_enter') {
    const gw = giveaways.get(interaction.message.id);
    if (!gw || gw.finished) { await interaction.reply({ content: '⚠️ This giveaway has ended.', ephemeral: true }); return; }
    const uid = interaction.user.id;
    if (gw.participants.has(uid)) {
      await interaction.reply({ content: '⚠️ You are already entered!', ephemeral: true });
    } else {
      gw.participants.add(uid);
      // Actualizar embed con nuevo conteo de participantes
      try {
        const updatedEmbed = buildActiveGWEmbed({
          prize: gw.prize, winners: gw.winners,
          endsAt: gw.endsAt, hostedBy: gw.hostedBy,
          participantCount: gw.participants.size
        });
        await interaction.message.edit({ embeds: [updatedEmbed] });
      } catch {}
      await interaction.reply({ content: `🎉 You entered for **${gw.prize}**! Good luck 🍀`, ephemeral: true });
    }
  }
});

// ─────────────────────────────────────────────
//  GIVEAWAY
// ─────────────────────────────────────────────
function buildActiveGWEmbed({ prize, winners, endsAt, hostedBy, participantCount = 0 }) {
  const now = new Date();
  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setDescription(
      `**${prize}**\n` +
      `End: <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n` +
      `Hosted by <@${hostedBy}>\n` +
      `Participants: ${participantCount}`
    )
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

function buildFinishedEmbed(gw) {
  const w   = gw.lastWinners.length ? gw.lastWinners.map(id => `<@${id}>`).join(', ') : 'No participants';
  const now = new Date();
  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setDescription(`**${gw.prize}**\nWinner${gw.winners > 1 ? 's' : ''}: ${w}\nHosted by <@${gw.hostedBy}>`)
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

async function endGiveaway(messageId) {
  const gw = giveaways.get(messageId);
  if (!gw || gw.finished) return;
  gw.finished    = true;
  gw.lastWinners = pickMultiple(gw.participants, gw.winners);
  try {
    const ch  = await client.channels.fetch(gw.channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({
      content: '𝜗𝜚　**Giveaway** **!!**',
      embeds: [buildFinishedEmbed(gw)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Secondary).setDisabled(true)
      )]
    });
    if (gw.lastWinners.length) {
      await ch.send(`ೀ. . .﹒ congratulation's ${gw.lastWinners.map(id => `<@${id}>`).join(', ')} **!!**, you won **(${gw.prize})**. You have ${gw.claimStr} to claim.\n-# claim in tickets`);
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

    const replyEmbed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(`"${response}"`)
      .setFooter({ text: `sent by ${sender.tag} · ${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });

    const followup = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(`-# if your question wasn't resolved or you need anything else, feel free to message again or open a ticket in the server.`);

    await targetUser.send({ embeds: [replyEmbed] });
    await targetUser.send({ embeds: [followup] });

    const confirm = new EmbedBuilder().setColor(0xFFFFFF).setDescription(`✅ Reply sent to **${targetUser.tag}**.`);
    if (interaction) await interaction.reply({ embeds: [confirm], ephemeral: true });
    else await channel.send({ embeds: [confirm] });
  } catch (err) {
    console.error('Reply error:', err);
    if (interaction) await interaction.reply({ content: '⚠️ Could not send reply.', ephemeral: true });
    else await channel.send('⚠️ Could not send reply. User may have DMs disabled.');
  }
}

// ─────────────────────────────────────────────
//  AR HELPERS
// ─────────────────────────────────────────────
async function listAR(message) {
  if (autoresponders.size === 0) { await message.reply('⚠️ No autoresponders set.'); return; }
  const list = [...autoresponders.keys()].map((t, i) => `${i + 1}. \`${t}\``).join('\n');
  await message.reply(`**Autoresponders:**\n${list}`);
}

async function listARSlash(interaction) {
  if (autoresponders.size === 0) { await interaction.reply({ content: '⚠️ No autoresponders set.', ephemeral: true }); return; }
  const list = [...autoresponders.keys()].map((t, i) => `${i + 1}. \`${t}\``).join('\n');
  await interaction.reply({ content: `**Autoresponders:**\n${list}`, ephemeral: true });
}

async function deleteAR(message, trigger) {
  if (!trigger) { await message.reply('⚠️ Provide a trigger.'); return; }
  autoresponders.delete(trigger.toLowerCase())
    ? await message.reply(`✅ Deleted \`${trigger}\`.`)
    : await message.reply(`⚠️ Trigger \`${trigger}\` not found.`);
}

async function deleteARSlash(interaction, trigger) {
  autoresponders.delete(trigger.toLowerCase())
    ? await interaction.reply({ content: `✅ Deleted \`${trigger}\`.`, ephemeral: true })
    : await interaction.reply({ content: `⚠️ Trigger \`${trigger}\` not found.`, ephemeral: true });
}

// ─────────────────────────────────────────────
//  STICKY HELPERS
// ─────────────────────────────────────────────
async function removeSticky(channel, message = null, interaction = null) {
  if (stickyMessages.has(channel.id)) {
    const sticky = stickyMessages.get(channel.id);
    try { const m = await channel.messages.fetch(sticky.messageId); await m.delete(); } catch {}
    stickyMessages.delete(channel.id);
    if (interaction) await interaction.reply({ content: '✅ Sticky removed.', ephemeral: true });
    else await message.reply('✅ Sticky removed.');
  } else {
    if (interaction) await interaction.reply({ content: '⚠️ No sticky in this channel.', ephemeral: true });
    else await message.reply('⚠️ No sticky in this channel.');
  }
}

// ─────────────────────────────────────────────
//  UTILIDADES
// ─────────────────────────────────────────────
function pickMultiple(set, count) {
  if (!set || set.size === 0) return [];
  const pool = [...set], result = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
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
