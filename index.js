const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  Collection
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

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const PREFIX        = '!';
const QUEUE_CH      = '1291958364288450613';
const MODMAIL_CH    = '1500722506611294259';
const GUILD_ID      = process.env.GUILD_ID;
const CLIENT_ID     = process.env.CLIENT_ID;

// ─────────────────────────────────────────────
//  ALMACENAMIENTO EN MEMORIA
// ─────────────────────────────────────────────
const autoresponders = new Map(); // trigger → { response, deleteMsg }
const giveaways      = new Map();
const stickyMessages = new Map(); // channelId → { messageId, content }
const pendingGW      = new Map(); // userId → setup data

// ─────────────────────────────────────────────
//  REGISTRO DE COMANDOS SLASH
// ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    // AUTORESPONDERS
    new SlashCommandBuilder()
      .setName('ar')
      .setDescription('Manage autoresponders')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('add').setDescription('Add an autoresponder'))
      .addSubcommand(s => s.setName('edit').setDescription('Edit an autoresponder')
        .addStringOption(o => o.setName('trigger').setDescription('Trigger to edit').setRequired(true)))
      .addSubcommand(s => s.setName('delete').setDescription('Delete an autoresponder')
        .addStringOption(o => o.setName('trigger').setDescription('Trigger to delete').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List all autoresponders')),

    // GIVEAWAY
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Start a giveaway')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('reroll')
      .setDescription('Re-roll giveaway winners')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)),

    // QUEUE
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Add a queue entry')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
      .addStringOption(o => o.setName('bought').setDescription('What they bought').setRequired(true))
      .addStringOption(o => o.setName('paid').setDescription('What they paid with').setRequired(true)),

    // STICKY
    new SlashCommandBuilder()
      .setName('sticky')
      .setDescription('Manage sticky messages')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('set').setDescription('Set sticky in this channel'))
      .addSubcommand(s => s.setName('remove').setDescription('Remove sticky from this channel')),

    // REPLY (modmail)
    new SlashCommandBuilder()
      .setName('reply')
      .setDescription('Reply to a modmail message')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(o => o.setName('userid').setDescription('User ID to reply to').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('Your reply').setRequired(true)),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands registered.');
  } catch (err) { console.error('Error registering commands:', err); }
}

// ─────────────────────────────────────────────
//  BOT LISTO
// ─────────────────────────────────────────────
client.once('clientReady', () => {
  console.log(`✅ Bot connected as ${client.user.tag}`);
  registerCommands();
});

// ─────────────────────────────────────────────
//  MENSAJES (prefix + autoresponders + sticky + modmail DM)
// ─────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── DM → modmail ──
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

  const content = message.content;
  const isPrefix = content.startsWith(PREFIX);

  // ── Prefix commands ──
  if (isPrefix) {
    const args    = content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // !reply
    if (command === 'reply') {
      const targetId = args.shift();
      const response = args.join(' ');
      if (!targetId || !response) { await message.reply('⚠️ Usage: `!reply <userID> <message>`'); return; }
      await handleReply(message, targetId, response);
      return;
    }

    // !ar add/edit/delete/list
    if (command === 'ar') {
      const sub = args.shift();
      if (sub === 'add')    { await openARModal(message, 'add'); return; }
      if (sub === 'list')   { await listAR(message); return; }
      if (sub === 'delete') { await deleteAR(message, args.join(' ')); return; }
      if (sub === 'edit')   { await openARModal(message, 'edit', args.join(' ')); return; }
    }

    // !giveaway
    if (command === 'giveaway') {
      await message.reply('⚠️ Use the slash command `/giveaway` to start a giveaway.');
      return;
    }

    // !queue
    if (command === 'queue') {
      await message.reply('⚠️ Use the slash command `/queue` to add a queue entry.');
      return;
    }

    // !sticky
    if (command === 'sticky') {
      const sub = args.shift();
      if (sub === 'set')    { await openStickyModal(message); return; }
      if (sub === 'remove') { await removeSticky(message); return; }
    }
  }

  // ── Autoresponders ──
  const lower = content.toLowerCase();
  for (const [trigger, data] of autoresponders) {
    if (lower.includes(trigger.toLowerCase())) {
      if (data.deleteMsg) {
        try { await message.delete(); } catch {}
      }
      await message.channel.send(data.response);
      break;
    }
  }

  // ── Sticky ──
  if (stickyMessages.has(message.channel.id)) {
    const sticky = stickyMessages.get(message.channel.id);
    try {
      const old = await message.channel.messages.fetch(sticky.messageId);
      await old.delete();
    } catch {}
    const sent = await message.channel.send(sticky.content);
    sticky.messageId = sent.id;
  }
});

// ─────────────────────────────────────────────
//  INTERACTIONS (slash + modals + selects + buttons)
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── SLASH COMMANDS ──
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // /ar
    if (commandName === 'ar') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add')    { await openARModalSlash(interaction, 'add'); return; }
      if (sub === 'list')   { await listARSlash(interaction); return; }
      if (sub === 'delete') { await deleteARSlash(interaction, interaction.options.getString('trigger')); return; }
      if (sub === 'edit')   { await openARModalSlash(interaction, 'edit', interaction.options.getString('trigger')); return; }
    }

    // /giveaway → modal paso 1
    if (commandName === 'giveaway') {
      const modal = new ModalBuilder().setCustomId('gw_modal1').setTitle('Giveaway Setup');
      modal.addComponents(
        mrow(minput('prize',    'Prize',                   'Prize name',   100)),
        mrow(minput('winners',  'Number of winners (max 10)', '1',           2)),
        mrow(minput('duration', 'Duration in minutes (min 0.5, max 23040)', 'e.g. 60', 6))
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

      const embed = new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setDescription(
          `_ _\n_ _\n` +
          `\u200B　　　　　　 ݁(<@${user.id}>)  ˳     ꔫ    \n` +
          `\u200B　　⎯⎯       _bought_: ${bought} ۫       ˖\n` +
          `\u200B　　♡ֹ   ֹ  pa**id** _with_: ${paid}\n` +
          `\u200B　　⎯⎯       _status_: **__ongoing__** ۫       ˖\n` +
          `_ _`
        );

      try {
        const ch  = await client.channels.fetch(QUEUE_CH);
        const msg = await ch.send({ embeds: [embed] });

        const select = new StringSelectMenuBuilder()
          .setCustomId(`queue_status_${msg.id}`)
          .setPlaceholder('Change status')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Ongoing').setValue('ongoing'),
            new StringSelectMenuOptionBuilder().setLabel('Noted').setValue('noted'),
            new StringSelectMenuOptionBuilder().setLabel('Done').setValue('done')
          );

        await msg.edit({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });

        giveaways.set(`queue_${msg.id}`, { user: user.id, bought, paid, messageId: msg.id, channelId: QUEUE_CH });
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
        if (stickyMessages.has(interaction.channel.id)) {
          const sticky = stickyMessages.get(interaction.channel.id);
          try { const old = await interaction.channel.messages.fetch(sticky.messageId); await old.delete(); } catch {}
          stickyMessages.delete(interaction.channel.id);
          await interaction.reply({ content: '✅ Sticky removed.', ephemeral: true });
        } else {
          await interaction.reply({ content: '⚠️ No sticky in this channel.', ephemeral: true });
        }
        return;
      }
    }

    // /reply
    if (commandName === 'reply') {
      const targetId = interaction.options.getString('userid');
      const response = interaction.options.getString('message');
      await handleReplySlash(interaction, targetId, response);
      return;
    }
  }

  // ── MODALS ──
  if (interaction.isModalSubmit()) {

    // Giveaway modal
    if (interaction.customId === 'gw_modal1') {
      const prize    = interaction.fields.getTextInputValue('prize').trim();
      const rawW     = interaction.fields.getTextInputValue('winners').trim();
      const rawDur   = interaction.fields.getTextInputValue('duration').trim();
      const winners  = clamp(parseInt(rawW, 10) || 1, 1, 10);
      const minutes  = parseFloat(rawDur);

      if (isNaN(minutes) || minutes < 0.5 || minutes > 23040) {
        await interaction.reply({ content: '⚠️ Invalid duration. Min 0.5 min, max 23040 min (16 days).', ephemeral: true });
        return;
      }

      // Modal paso 2: claim time
      pendingGW.set(interaction.user.id, { prize, winners, minutes });

      const modal2 = new ModalBuilder().setCustomId('gw_modal2').setTitle('Giveaway — Claim Time');
      modal2.addComponents(
        mrow(minput('claimtime', 'Claim time in minutes (min 0.17, max 60)', 'e.g. 5', 4))
      );
      await interaction.showModal(modal2);
      return;
    }

    if (interaction.customId === 'gw_modal2') {
      const setup = pendingGW.get(interaction.user.id);
      if (!setup) { await interaction.reply({ content: '⚠️ Session expired. Try /giveaway again.', ephemeral: true }); return; }
      pendingGW.delete(interaction.user.id);

      const rawClaim  = interaction.fields.getTextInputValue('claimtime').trim();
      const claimMins = parseFloat(rawClaim);

      if (isNaN(claimMins) || claimMins < 0.17 || claimMins > 60) {
        await interaction.reply({ content: '⚠️ Invalid claim time. Min 10s (0.17), max 60 min.', ephemeral: true });
        return;
      }

      const { prize, winners, minutes } = setup;
      const endsAt    = new Date(Date.now() + minutes * 60 * 1000);
      const hostedBy  = interaction.user.id;
      const claimMs   = claimMins * 60 * 1000;

      const claimStr = claimMins < 1
        ? `${Math.round(claimMins * 60)}s`
        : `${claimMins}m`;

      const embed = buildActiveGWEmbed({ prize, winners, endsAt, hostedBy });
      await interaction.reply({ content: '✅ Giveaway created!', ephemeral: true });

      const msg = await interaction.channel.send({
        content: '𝜗𝜚　**Giveaway** **!!**',
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Primary)
        )]
      });

      giveaways.set(msg.id, {
        prize, winners, endsAt, hostedBy, claimStr, claimMs,
        channelId: interaction.channel.id,
        messageId: msg.id,
        participants: new Set(),
        lastWinners: [],
        finished: false
      });

      setTimeout(() => endGiveaway(msg.id), minutes * 60 * 1000);
      return;
    }

    // Sticky modal
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

    // AR modal
    if (interaction.customId.startsWith('ar_modal_')) {
      const mode    = interaction.customId.includes('_edit_') ? 'edit' : 'add';
      const trigger = interaction.fields.getTextInputValue('ar_trigger').trim().toLowerCase();
      const response= interaction.fields.getTextInputValue('ar_response').trim();
      const delMsg  = interaction.fields.getTextInputValue('ar_delete').trim().toLowerCase() === 'yes';

      autoresponders.set(trigger, { response, deleteMsg: delMsg });
      await interaction.reply({ content: `✅ Autoresponder \`${trigger}\` ${mode === 'edit' ? 'updated' : 'added'}.`, ephemeral: true });
      return;
    }
  }

  // ── SELECT MENU (queue status) ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('queue_status_')) {
    const msgId  = interaction.customId.replace('queue_status_', '');
    const status = interaction.values[0];
    const entry  = giveaways.get(`queue_${msgId}`);
    if (!entry) { await interaction.reply({ content: '⚠️ Queue entry not found.', ephemeral: true }); return; }

    const statusLabel = status === 'ongoing' ? '**__ongoing__**' : status === 'noted' ? '**__noted__**' : '**__done__**';

    const embed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(
        `_ _\n_ _\n` +
        `\u200B　　　　　　 ݁(<@${entry.user}>)  ˳     ꔫ    \n` +
        `\u200B　　⎯⎯       _bought_: ${entry.bought} ۫       ˖\n` +
        `\u200B　　♡ֹ   ֹ  pa**id** _with_: ${entry.paid}\n` +
        `\u200B　　⎯⎯       _status_: ${statusLabel} ۫       ˖\n` +
        `_ _`
      );

    const select = new StringSelectMenuBuilder()
      .setCustomId(`queue_status_${msgId}`)
      .setPlaceholder('Change status')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Ongoing').setValue('ongoing'),
        new StringSelectMenuOptionBuilder().setLabel('Noted').setValue('noted'),
        new StringSelectMenuOptionBuilder().setLabel('Done').setValue('done')
      );

    try {
      const ch  = await client.channels.fetch(QUEUE_CH);
      const msg = await ch.messages.fetch(msgId);
      await msg.edit({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
      await interaction.reply({ content: `✅ Status updated to **${status}**.`, ephemeral: true });
    } catch { await interaction.reply({ content: '⚠️ Could not update status.', ephemeral: true }); }
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
      await interaction.reply({ content: `🎉 You entered for **${gw.prize}**! Good luck 🍀`, ephemeral: true });
    }
  }
});

// ─────────────────────────────────────────────
//  GIVEAWAY HELPERS
// ─────────────────────────────────────────────
function buildActiveGWEmbed({ prize, winners, endsAt, hostedBy }) {
  const now = new Date();
  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setDescription(
      `**${prize}**\n` +
      `End: <t:${Math.floor(endsAt.getTime() / 1000)}:R>\n` +
      `Hosted by <@${hostedBy}>`
    )
    .setFooter({ text: `${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });
}

function buildFinishedEmbed(gw) {
  const w = gw.lastWinners.length ? gw.lastWinners.map(id => `<@${id}>`).join(', ') : 'No participants';
  const now = new Date();
  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setDescription(
      `**${gw.prize}**\n` +
      `Winner${gw.winners > 1 ? 's' : ''}: ${w}\n` +
      `Hosted by <@${gw.hostedBy}>`
    )
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
        new ButtonBuilder().setCustomId('gw_enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Primary).setDisabled(true)
      )]
    });

    if (gw.lastWinners.length) {
      const winnersStr = gw.lastWinners.map(id => `<@${id}>`).join(', ');
      await ch.send(
        `ೀ. . .﹒ congratulation's ${winnersStr} **!!**, you won **(${gw.prize})**. You have ${gw.claimStr} to claim.\n-# claim in tickets`
      );
    } else {
      await ch.send(`No one entered the giveaway for **${gw.prize}**. 😔`);
    }
  } catch (err) { console.error('Error ending giveaway:', err); }
}

// ─────────────────────────────────────────────
//  MODMAIL REPLY HELPERS
// ─────────────────────────────────────────────
async function handleReply(message, targetId, response) {
  try {
    const targetUser = await client.users.fetch(targetId);
    const now = new Date();

    const replyEmbed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(`"${response}"`)
      .setFooter({ text: `sent by ${message.author.tag} · ${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });

    const followup = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(`-# if your question wasn't resolved or you need anything else, feel free to message again or open a ticket in the server.`);

    await targetUser.send({ embeds: [replyEmbed] });
    await targetUser.send({ embeds: [followup] });

    const confirm = new EmbedBuilder().setColor(0xFFFFFF).setDescription(`✅ Reply sent to **${targetUser.tag}**.`);
    await message.channel.send({ embeds: [confirm] });
  } catch (err) {
    console.error('Reply error:', err);
    await message.reply('⚠️ Could not send reply. User may have DMs disabled.');
  }
}

async function handleReplySlash(interaction, targetId, response) {
  try {
    const targetUser = await client.users.fetch(targetId);
    const now = new Date();

    const replyEmbed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(`"${response}"`)
      .setFooter({ text: `sent by ${interaction.user.tag} · ${now.toLocaleDateString()} ${now.toLocaleTimeString()}` });

    const followup = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setDescription(`-# if your question wasn't resolved or you need anything else, feel free to message again or open a ticket in the server.`);

    await targetUser.send({ embeds: [replyEmbed] });
    await targetUser.send({ embeds: [followup] });

    await interaction.reply({ content: `✅ Reply sent to **${targetUser.tag}**.`, ephemeral: true });
  } catch (err) {
    console.error('Reply error:', err);
    await interaction.reply({ content: '⚠️ Could not send reply. User may have DMs disabled.', ephemeral: true });
  }
}

// ─────────────────────────────────────────────
//  AUTORESPONDER HELPERS
// ─────────────────────────────────────────────
async function openARModal(message, mode, trigger = '') {
  await message.reply(`⚠️ Use the slash command \`/ar ${mode}\` to ${mode} an autoresponder.`);
}

async function openARModalSlash(interaction, mode, trigger = '') {
  const modal = new ModalBuilder()
    .setCustomId(`ar_modal_${mode}_${Date.now()}`)
    .setTitle(mode === 'add' ? 'Add Autoresponder' : 'Edit Autoresponder');

  const triggerInput = new TextInputBuilder()
    .setCustomId('ar_trigger').setLabel('Trigger word/phrase')
    .setStyle(TextInputStyle.Short).setRequired(true);
  if (trigger) triggerInput.setValue(trigger);

  const existing = trigger ? autoresponders.get(trigger.toLowerCase()) : null;

  const responseInput = new TextInputBuilder()
    .setCustomId('ar_response').setLabel('Response')
    .setStyle(TextInputStyle.Paragraph).setRequired(true);
  if (existing) responseInput.setValue(existing.response);

  const deleteInput = new TextInputBuilder()
    .setCustomId('ar_delete').setLabel('Delete trigger message? (yes/no)')
    .setStyle(TextInputStyle.Short).setRequired(true)
    .setValue(existing?.deleteMsg ? 'yes' : 'no');

  modal.addComponents(mrow(triggerInput), mrow(responseInput), mrow(deleteInput));
  await interaction.showModal(modal);
}

async function listARSlash(interaction) {
  if (autoresponders.size === 0) {
    await interaction.reply({ content: '⚠️ No autoresponders set.', ephemeral: true }); return;
  }
  const list = [...autoresponders.keys()].map((t, i) => `${i + 1}. \`${t}\``).join('\n');
  await interaction.reply({ content: `**Autoresponders:**\n${list}`, ephemeral: true });
}

async function listAR(message) {
  if (autoresponders.size === 0) { await message.reply('⚠️ No autoresponders set.'); return; }
  const list = [...autoresponders.keys()].map((t, i) => `${i + 1}. \`${t}\``).join('\n');
  await message.reply(`**Autoresponders:**\n${list}`);
}

async function deleteAR(message, trigger) {
  if (!trigger) { await message.reply('⚠️ Provide a trigger: `!ar delete <trigger>`'); return; }
  if (autoresponders.delete(trigger.toLowerCase())) {
    await message.reply(`✅ Autoresponder \`${trigger}\` deleted.`);
  } else {
    await message.reply(`⚠️ Trigger \`${trigger}\` not found.`);
  }
}

async function deleteARSlash(interaction, trigger) {
  if (autoresponders.delete(trigger.toLowerCase())) {
    await interaction.reply({ content: `✅ Autoresponder \`${trigger}\` deleted.`, ephemeral: true });
  } else {
    await interaction.reply({ content: `⚠️ Trigger \`${trigger}\` not found.`, ephemeral: true });
  }
}

// ─────────────────────────────────────────────
//  STICKY PREFIX HELPERS
// ─────────────────────────────────────────────
async function openStickyModal(message) {
  await message.reply('⚠️ Use the slash command `/sticky set` to set a sticky message.');
}

async function removeSticky(message) {
  if (stickyMessages.has(message.channel.id)) {
    const sticky = stickyMessages.get(message.channel.id);
    try { const m = await message.channel.messages.fetch(sticky.messageId); await m.delete(); } catch {}
    stickyMessages.delete(message.channel.id);
    await message.reply('✅ Sticky removed.');
  } else {
    await message.reply('⚠️ No sticky in this channel.');
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

// ─────────────────────────────────────────────
//  ARRANCAR
// ─────────────────────────────────────────────
client.login(process.env.TOKEN);
