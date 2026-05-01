const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits
} = require('discord.js');

require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// giveaways activos y terminados en memoria
const giveaways = new Map();

// ─────────────────────────────────────────────
//  REGISTRO DE COMANDOS
// ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Inicia un giveaway con dos premios')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName('reroll')
      .setDescription('Re-sortea ganadores de un giveaway terminado')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(opt =>
        opt.setName('message_id')
          .setDescription('ID del mensaje del giveaway')
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt.setName('premio')
          .setDescription('¿Cuál premio re-sortear?')
          .setRequired(true)
          .addChoices(
            { name: 'Premio 1', value: 1 },
            { name: 'Premio 2', value: 2 },
            { name: 'Ambos',    value: 0 }
          )
      )
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Comandos /giveaway y /reroll registrados.');
  } catch (err) {
    console.error('Error registrando comandos:', err);
  }
}

// ─────────────────────────────────────────────
//  BOT LISTO
// ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  registerCommands();
});

// ─────────────────────────────────────────────
//  INTERACCIONES
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── /giveaway → abrir modal (1 solo, 5 campos) ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'giveaway') {
    const modal = new ModalBuilder()
      .setCustomId('giveaway_modal')
      .setTitle('Configurar Giveaway');

    // Campo 1: Premio 1 con emoji y ganadores en un solo campo
    // Formato: "🎁 | Manga de Naruto | 1"
    // Campo 2: Premio 2 con emoji y ganadores en un solo campo
    // Formato: "🏆 | Rol exclusivo | 2"
    // Campo 3: Duración
    // Así metemos 7 datos en 3 campos y quedan 2 libres por si acaso

    modal.addComponents(
      makeRow(
        makeInput(
          'data1',
          'Premio 1  →  emoji | nombre | ganadores',
          'Ej:  🎁 | Manga de Naruto | 1',
          100
        )
      ),
      makeRow(
        makeInput(
          'data2',
          'Premio 2  →  emoji | nombre | ganadores',
          'Ej:  🏆 | Rol exclusivo | 2',
          100
        )
      ),
      makeRow(
        makeInput(
          'duration',
          'Duración en minutos  (mín 1 – máx 10080)',
          'Ej:  60',
          5
        )
      )
    );

    await interaction.showModal(modal);
    return;
  }

  // ── Modal enviado → parsear y crear giveaway ──
  if (interaction.isModalSubmit() && interaction.customId === 'giveaway_modal') {
    const raw1  = interaction.fields.getTextInputValue('data1').trim();
    const raw2  = interaction.fields.getTextInputValue('data2').trim();
    const rawDur = interaction.fields.getTextInputValue('duration').trim();

    // Parsear formato "emoji | nombre | ganadores"
    const parts1 = raw1.split('|').map(s => s.trim());
    const parts2 = raw2.split('|').map(s => s.trim());

    if (parts1.length < 3 || parts2.length < 3) {
      await interaction.reply({
        content: '⚠️ Formato incorrecto. Usa el formato: `emoji | nombre del premio | número de ganadores`\nEjemplo: `🎁 | Manga de Naruto | 1`',
        ephemeral: true
      });
      return;
    }

    const emoji1   = parts1[0];
    const prize1   = parts1[1];
    const winners1 = clamp(parseInt(parts1[2], 10) || 1, 1, 20);

    const emoji2   = parts2[0];
    const prize2   = parts2[1];
    const winners2 = clamp(parseInt(parts2[2], 10) || 1, 1, 20);

    const minutes = parseInt(rawDur, 10);
    if (isNaN(minutes) || minutes < 1 || minutes > 10080) {
      await interaction.reply({
        content: '⚠️ Duración inválida. Ingresa un número entre 1 y 10080.',
        ephemeral: true
      });
      return;
    }

    const endsAt = new Date(Date.now() + minutes * 60 * 1000);

    const embed      = buildActiveEmbed({ prize1, emoji1, winners1, prize2, emoji2, winners2, endsAt });
    const components = buildButtons({ prize1, emoji1, prize2, emoji2, disabled: false });

    await interaction.reply({ content: '✅ ¡Giveaway creado!', ephemeral: true });
    const msg = await interaction.channel.send({ embeds: [embed], components });

    giveaways.set(msg.id, {
      prize1, emoji1, winners1,
      prize2, emoji2, winners2,
      endsAt,
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

  // ── Clic en botón → inscribir participante ──
  if (interaction.isButton()) {
    const gw = giveaways.get(interaction.message.id);

    if (!gw || gw.finished) {
      await interaction.reply({ content: '⚠️ Este giveaway ya terminó.', ephemeral: true });
      return;
    }

    const uid = interaction.user.id;

    if (interaction.customId === 'giveaway_btn1') {
      if (gw.participants1.has(uid)) {
        await interaction.reply({ content: `⚠️ Ya estás participando por **${gw.prize1}**.`, ephemeral: true });
      } else {
        gw.participants1.add(uid);
        await interaction.reply({ content: `${gw.emoji1} ¡Te inscribiste en **${gw.prize1}**! Buena suerte 🍀`, ephemeral: true });
      }
    } else if (interaction.customId === 'giveaway_btn2') {
      if (gw.participants2.has(uid)) {
        await interaction.reply({ content: `⚠️ Ya estás participando por **${gw.prize2}**.`, ephemeral: true });
      } else {
        gw.participants2.add(uid);
        await interaction.reply({ content: `${gw.emoji2} ¡Te inscribiste en **${gw.prize2}**! Buena suerte 🍀`, ephemeral: true });
      }
    }
    return;
  }

  // ── /reroll ──
  if (interaction.isChatInputCommand() && interaction.commandName === 'reroll') {
    const msgId  = interaction.options.getString('message_id').trim();
    const premio = interaction.options.getInteger('premio');

    const gw = giveaways.get(msgId);

    if (!gw) {
      await interaction.reply({ content: '⚠️ No encontré un giveaway con esa ID.', ephemeral: true });
      return;
    }
    if (!gw.finished) {
      await interaction.reply({ content: '⚠️ El giveaway todavía está activo.', ephemeral: true });
      return;
    }

    if (premio === 0 || premio === 1) gw.lastWinners1 = pickMultiple(gw.participants1, gw.winners1);
    if (premio === 0 || premio === 2) gw.lastWinners2 = pickMultiple(gw.participants2, gw.winners2);

    try {
      const channel = await client.channels.fetch(gw.channelId);
      const message = await channel.messages.fetch(msgId);
      await message.edit({ embeds: [buildFinishedEmbed(gw)] });

      let txt = '🔄 **¡Re-sorteo realizado!**\n';
      if (premio === 0 || premio === 1) txt += fmtWinners(gw.emoji1, gw.prize1, gw.lastWinners1) + '\n';
      if (premio === 0 || premio === 2) txt += fmtWinners(gw.emoji2, gw.prize2, gw.lastWinners2);

      await interaction.reply({ content: txt });
    } catch (err) {
      console.error('Error en reroll:', err);
      await interaction.reply({ content: '⚠️ No pude editar el mensaje. Verifica los permisos del bot.', ephemeral: true });
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
      embeds: [buildFinishedEmbed(gw)],
      components: buildButtons({
        prize1: gw.prize1, emoji1: gw.emoji1,
        prize2: gw.prize2, emoji2: gw.emoji2,
        disabled: true
      })
    });

    let announcement = '🎊 **¡El giveaway ha terminado!**\n';
    announcement += fmtWinners(gw.emoji1, gw.prize1, gw.lastWinners1) + '\n';
    announcement += fmtWinners(gw.emoji2, gw.prize2, gw.lastWinners2);
    announcement += `\n\n*¿El ganador no reclamó? Usa \`/reroll message_id:${messageId}\`*`;

    await channel.send(announcement);
  } catch (err) {
    console.error('Error al finalizar giveaway:', err);
  }
}

// ─────────────────────────────────────────────
//  CONSTRUCTORES
// ─────────────────────────────────────────────
function buildActiveEmbed({ prize1, emoji1, winners1, prize2, emoji2, winners2, endsAt }) {
  return new EmbedBuilder()
    .setTitle('🎉 ¡GIVEAWAY!')
    .setColor(0x9B59B6)
    .addFields(
      {
        name: `${emoji1} Premio 1`,
        value: `**${prize1}**\n🏅 ${winners1} ganador${winners1 > 1 ? 'es' : ''}`,
        inline: true
      },
      {
        name: `${emoji2} Premio 2`,
        value: `**${prize2}**\n🏅 ${winners2} ganador${winners2 > 1 ? 'es' : ''}`,
        inline: true
      },
      {
        name: '⏰ Termina',
        value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`,
        inline: false
      }
    )
    .setFooter({ text: '¡Haz clic en un botón para participar! Puedes participar en ambos.' })
    .setTimestamp(endsAt);
}

function buildFinishedEmbed(gw) {
  const w1 = gw.lastWinners1.length ? gw.lastWinners1.map(id => `<@${id}>`).join(', ') : '😔 Sin participantes';
  const w2 = gw.lastWinners2.length ? gw.lastWinners2.map(id => `<@${id}>`).join(', ') : '😔 Sin participantes';

  return new EmbedBuilder()
    .setTitle('🎊 ¡GIVEAWAY TERMINADO!')
    .setColor(0x2ECC71)
    .addFields(
      {
        name: `${gw.emoji1} Premio 1: ${gw.prize1}`,
        value: `🏅 **Ganador${gw.winners1 > 1 ? 'es' : ''}:** ${w1}\n👥 Participantes: ${gw.participants1.size}`,
        inline: false
      },
      {
        name: `${gw.emoji2} Premio 2: ${gw.prize2}`,
        value: `🏅 **Ganador${gw.winners2 > 1 ? 'es' : ''}:** ${w2}\n👥 Participantes: ${gw.participants2.size}`,
        inline: false
      }
    )
    .setFooter({ text: `Re-sortear: /reroll message_id:${gw.messageId}` })
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
  if (!winners.length) return `${emoji} **${prize}** → 😔 Sin participantes`;
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
