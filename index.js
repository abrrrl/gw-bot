const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits
} = require('discord.js');

require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const giveaways = new Map();

// ─────────────────────────────────────────────
//  REGISTRO DE COMANDOS
// ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Start a giveaway with two prizes')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('reroll')
      .setDescription('Re-roll the winners of a finished giveaway')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('message_id')
          .setDescription('ID of the giveaway message')
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName('prize')
          .setDescription('Which prize to re-roll?')
          .setRequired(true)
          .addChoices(
            { name: 'Prize 1', value: 1 },
            { name: 'Prize 2', value: 2 },
            { name: 'Both',    value: 0 }
          )
      )
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Commands /giveaway and /reroll registered.');
  } catch (err) {
    console.error('Error registering commands:', err);
  }
}

// ─────────────────────────────────────────────
//  BOT LISTO
// ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Bot connected as ${client.user.tag}`);
  registerCommands();
});

// ─────────────────────────────────────────────
//  INTERACCIONES
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── /giveaway → modal ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'giveaway') {
    const modal = new ModalBuilder()
      .setCustomId('giveaway_modal')
      .setTitle('Giveaway Setup');

    modal.addComponents(
      makeRow(makeInput('data1',    'Prize 1  —  emoji , name , winners',  'Prize 1',   100)),
      makeRow(makeInput('data2',    'Prize 2  —  emoji , name , winners',  'Prize 2',   100)),
      makeRow(makeInput('duration', 'Duration in minutes',                 'Duration',    5))
    );

    await interaction.showModal(modal);
    return;
  }

  // ── Modal enviado → crear giveaway ──
  if (interaction.isModalSubmit() && interaction.customId === 'giveaway_modal') {
    const raw1   = interaction.fields.getTextInputValue('data1').trim();
    const raw2   = interaction.fields.getTextInputValue('data2').trim();
    const rawDur = interaction.fields.getTextInputValue('duration').trim();

    // Formato separado por coma: "emoji , nombre , ganadores"
    const parts1 = raw1.split(',').map(s => s.trim());
    const parts2 = raw2.split(',').map(s => s.trim());

    if (parts1.length < 3 || parts2.length < 3) {
      await interaction.reply({
        content: '⚠️ Wrong format. Use: `emoji , prize name , number of winners`',
        ephemeral: true
      });
      return;
    }

    const emoji1   = parts1[0];
    const prize1   = parts1[1];
    const winners1 = clamp(parseInt(parts1[2], 10) || 1, 1, 10);

    const emoji2   = parts2[0];
    const prize2   = parts2[1];
    const winners2 = clamp(parseInt(parts2[2], 10) || 1, 1, 10);

    // Mínimo 0.5 min (30 seg), máximo 10080 min (7 días)
    const minutes = parseFloat(rawDur);
    if (isNaN(minutes) || minutes < 0.5 || minutes > 10080) {
      await interaction.reply({
        content: '⚠️ Invalid duration.',
        ephemeral: true
      });
      return;
    }

    const endsAt = new Date(Date.now() + minutes * 60 * 1000);
    const hostedBy = interaction.user.id;

    const embed      = buildActiveEmbed({ prize1, emoji1, winners1, prize2, emoji2, winners2, endsAt, hostedBy });
    const components = buildButtons({ prize1, emoji1, prize2, emoji2, disabled: false });

    await interaction.reply({ content: '✅ Giveaway created!', ephemeral: true });
    const msg = await interaction.channel.send({
      content: '𝜗𝜚　**Giveaway** **!!**',
      embeds: [embed],
      components
    });

    giveaways.set(msg.id, {
      prize1, emoji1, winners1,
      prize2, emoji2, winners2,
      endsAt,
      hostedBy,
      channelId: interaction.channel.id,
      messageId: msg.id,
      participants1: new Set(),
      participants2: new Set(),
      lastWinners1: [],
      lastWinners2: [],
      finished: false
    });

    setTimeout(() => endGiveaway(msg.id), minutes * 60 * 1000);
    return;
  }

  // ── Clic en botón → inscribir ──
  if (interaction.isButton()) {
    const gw = giveaways.get(interaction.message.id);

    if (!gw || gw.finished) {
      await interaction.reply({ content: '⚠️ This giveaway has already ended.', ephemeral: true });
      return;
    }

    const uid = interaction.user.id;

    if (interaction.customId === 'giveaway_btn1') {
      if (gw.participants1.has(uid)) {
        await interaction.reply({ content: `⚠️ You are already entering for **${gw.prize1}**.`, ephemeral: true });
      } else {
        gw.participants1.add(uid);
        await interaction.reply({ content: `${gw.emoji1} You entered for **${gw.prize1}**! Good luck 🍀`, ephemeral: true });
      }
    } else if (interaction.customId === 'giveaway_btn2') {
      if (gw.participants2.has(uid)) {
        await interaction.reply({ content: `⚠️ You are already entering for **${gw.prize2}**.`, ephemeral: true });
      } else {
        gw.participants2.add(uid);
        await interaction.reply({ content: `${gw.emoji2} You entered for **${gw.prize2}**! Good luck 🍀`, ephemeral: true });
      }
    }
    return;
  }

  // ── /reroll ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'reroll') {
    const msgId = interaction.options.getString('message_id').trim();
    const prize = interaction.options.getInteger('prize');

    const gw = giveaways.get(msgId);

    if (!gw) {
      await interaction.reply({ content: '⚠️ No giveaway found with that message ID.', ephemeral: true });
      return;
    }
    if (!gw.finished) {
      await interaction.reply({ content: '⚠️ This giveaway is still active.', ephemeral: true });
      return;
    }

    if (prize === 0 || prize === 1) gw.lastWinners1 = pickMultiple(gw.participants1, gw.winners1);
    if (prize === 0 || prize === 2) gw.lastWinners2 = pickMultiple(gw.participants2, gw.winners2);

    try {
      const channel = await client.channels.fetch(gw.channelId);
      const message = await channel.messages.fetch(msgId);
      await message.edit({ embeds: [buildFinishedEmbed(gw)] });

      let txt = '🔄 **Re-roll completed!**\n';
      if (prize === 0 || prize === 1) txt += fmtWinners(gw.emoji1, gw.prize1, gw.lastWinners1) + '\n';
      if (prize === 0 || prize === 2) txt += fmtWinners(gw.emoji2, gw.prize2, gw.lastWinners2);

      await interaction.reply({ content: txt });
    } catch (err) {
      console.error('Reroll error:', err);
      await interaction.reply({ content: '⚠️ Could not edit the message. Check bot permissions.', ephemeral: true });
    }
  }
});

// ─────────────────────────────────────────────
//  FINALIZAR GIVEAWAY
// ─────────────────────────────────────────────
async function endGiveaway(messageId) {
  const gw = giveaways.get(messageId);
  if (!gw || gw.finished) return;

  gw.finished = true;
  gw.lastWinners1 = pickMultiple(gw.participants1, gw.winners1);
  gw.lastWinners2 = pickMultiple(gw.participants2, gw.winners2);

  try {
    const channel = await client.channels.fetch(gw.channelId);
    const message = await channel.messages.fetch(messageId);

    await message.edit({
      content: '𝜗𝜚　**Giveaway** **!!**',
      embeds: [buildFinishedEmbed(gw)],
      components: buildButtons({
        prize1: gw.prize1, emoji1: gw.emoji1,
        prize2: gw.prize2, emoji2: gw.emoji2,
        disabled: true
      })
    });

    let announcement = '🎊 **The giveaway has ended!**\n';
    announcement += fmtWinners(gw.emoji1, gw.prize1, gw.lastWinners1) + '\n';
    announcement += fmtWinners(gw.emoji2, gw.prize2, gw.lastWinners2);
    announcement += `\n\n*Winner didn't claim their prize? Use \`/reroll message_id:${messageId}\`*`;

    await channel.send(announcement);
  } catch (err) {
    console.error('Error ending giveaway:', err);
  }
}

// ─────────────────────────────────────────────
//  CONSTRUCTORES
// ─────────────────────────────────────────────
function buildActiveEmbed({ prize1, emoji1, winners1, prize2, emoji2, winners2, endsAt, hostedBy }) {
  return new EmbedBuilder()
    .setTitle(`${emoji1} ${prize1}　⟢　${emoji2} ${prize2}`)
    .setColor(0x9B59B6)
    .addFields(
      {
        name: 'End',
        value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`,
        inline: true
      },
      {
        name: 'Hosted by',
        value: `<@${hostedBy}>`,
        inline: true
      },
      {
        name: `Participants for ${prize1}`,
        value: '0',
        inline: false
      },
      {
        name: `Participants for ${prize2}`,
        value: '0',
        inline: false
      }
    )
    .setFooter({ text: `Max ${winners1} winner${winners1 > 1 ? 's' : ''} for ${prize1}  ·  Max ${winners2} winner${winners2 > 1 ? 's' : ''} for ${prize2}` })
    .setTimestamp(endsAt);
}

function buildFinishedEmbed(gw) {
  const w1 = gw.lastWinners1.length ? gw.lastWinners1.map(id => `<@${id}>`).join(', ') : 'No participants';
  const w2 = gw.lastWinners2.length ? gw.lastWinners2.map(id => `<@${id}>`).join(', ') : 'No participants';

  return new EmbedBuilder()
    .setTitle(`${gw.emoji1} ${gw.prize1}　⟢　${gw.emoji2} ${gw.prize2}`)
    .setColor(0x2ECC71)
    .addFields(
      {
        name: 'Hosted by',
        value: `<@${gw.hostedBy}>`,
        inline: true
      },
      {
        name: `Participants for ${gw.prize1}`,
        value: `${gw.participants1.size}`,
        inline: true
      },
      {
        name: `Participants for ${gw.prize2}`,
        value: `${gw.participants2.size}`,
        inline: true
      },
      {
        name: `${gw.emoji1} Winner${gw.winners1 > 1 ? 's' : ''} — ${gw.prize1}`,
        value: w1,
        inline: false
      },
      {
        name: `${gw.emoji2} Winner${gw.winners2 > 1 ? 's' : ''} — ${gw.prize2}`,
        value: w2,
        inline: false
      }
    )
    .setFooter({ text: `Re-roll: /reroll message_id:${gw.messageId}` })
    .setTimestamp();
}

function buildButtons({ prize1, emoji1, prize2, emoji2, disabled }) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('giveaway_btn1')
        .setLabel(`${emoji1} ${prize1}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('giveaway_btn2')
        .setLabel(`${emoji2} ${prize2}`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    )
  ];
}

// ─────────────────────────────────────────────
//  UTILIDADES
// ─────────────────────────────────────────────
function pickMultiple(set, count) {
  if (!set || set.size === 0) return [];
  const pool = [...set];
  const result = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

function fmtWinners(emoji, prize, winners) {
  if (!winners.length) return `${emoji} **${prize}** → No participants`;
  return `${emoji} **${prize}** → ${winners.map(id => `<@${id}>`).join(', ')} 🎉`;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function makeInput(id, label, placeholder, maxLength) {
  return new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder)
    .setRequired(true)
    .setMaxLength(maxLength);
}

function makeRow(component) {
  return new ActionRowBuilder().addComponents(component);
}

// ─────────────────────────────────────────────
//  ARRANCAR
// ─────────────────────────────────────────────
client.login(process.env.TOKEN);
