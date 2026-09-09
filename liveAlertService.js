import axios from 'axios';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_BATCH = 100;

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function validHttpUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function twitchUrl(username) {
  return `https://www.twitch.tv/${encodeURIComponent(username)}`;
}

function buildLiveEmbed(streamer, stream) {
  const startedAt = stream?.started_at ? new Date(stream.started_at) : new Date();

  const embed = new EmbedBuilder()
    .setColor(0x111111)
    .setAuthor({ name: 'LIVE // SIGNAL FOUND' })
    .setTitle(`${streamer.displayName || streamer.username} just became live now`)
    .setDescription(stream?.title || streamer.description || 'Live now.')
    .setFooter({
      text: `${streamer.footer || 'SEV // BLACKLIST // LIVE'} • ${startedAt.toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: process.env.LIVE_ALERTS_TIMEZONE || 'Australia/Perth',
      })}`,
    })
    .setTimestamp(startedAt);

  const image = streamer.gifUrl || stream?.thumbnail_url;
  if (validHttpUrl(image)) {
    // Thumbnail places the artwork in the upper-right, matching the reference card.
    embed.setThumbnail(image.replace('{width}', '320').replace('{height}', '180'));
  }

  return embed;
}

function buildButtons(streamer) {
  const row = new ActionRowBuilder();

  if (validHttpUrl(streamer.tiktokUrl)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Watch on TikTok')
        .setStyle(ButtonStyle.Link)
        .setURL(streamer.tiktokUrl),
    );
  }

  if (validHttpUrl(streamer.twitchUrl)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Watch on Twitch')
        .setStyle(ButtonStyle.Link)
        .setURL(streamer.twitchUrl),
    );
  }

  return row.components.length ? row : null;
}

export class LiveAlertService {
  constructor(client) {
    this.client = client;
    this.timer = null;
    this.running = false;
    this.state = new Map();
    this.token = null;
    this.tokenExpiresAt = 0;
    this.pollInProgress = false;
  }

  isEnabled() {
    return envBool('LIVE_ALERTS_ENABLED', false)
      && Boolean(process.env.TWITCH_CLIENT_ID)
      && Boolean(process.env.TWITCH_CLIENT_SECRET);
  }

  start() {
    if (!this.isEnabled()) {
      logger.info(
        'Live alerts are disabled. Set LIVE_ALERTS_ENABLED=true, TWITCH_CLIENT_ID, and TWITCH_CLIENT_SECRET to enable them.',
      );
      return;
    }

    if (this.running) return;
    this.running = true;

    const intervalMs = Math.max(
      30_000,
      Number(process.env.LIVE_ALERTS_INTERVAL_SECONDS || 60) * 1000,
    );

    logger.info(`Live alert monitor started (polling every ${Math.round(intervalMs / 1000)}s).`);
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const response = await axios.post(TWITCH_TOKEN_URL, null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      },
      timeout: 10_000,
    });

    this.token = response.data.access_token;
    this.tokenExpiresAt = Date.now() + Number(response.data.expires_in || 0) * 1000;
    return this.token;
  }

  async getLiveStreams(usernames) {
    const unique = [...new Set(usernames.map(v => String(v).trim().toLowerCase()).filter(Boolean))];
    const live = new Map();

    if (!unique.length) return live;

    const token = await this.getAccessToken();

    for (let i = 0; i < unique.length; i += MAX_BATCH) {
      const batch = unique.slice(i, i + MAX_BATCH);
      const params = new URLSearchParams();
      for (const username of batch) params.append('user_login', username);

      const response = await axios.get(`${TWITCH_STREAMS_URL}?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-ID': process.env.TWITCH_CLIENT_ID,
        },
        timeout: 10_000,
      });

      for (const stream of response.data.data || []) {
        live.set(String(stream.user_login).toLowerCase(), stream);
      }
    }

    return live;
  }

  async poll() {
    if (this.pollInProgress || !this.isEnabled()) return;
    this.pollInProgress = true;

    try {
      const watchers = [];

      for (const guild of this.client.guilds.cache.values()) {
        const config = await getGuildConfig(this.client, guild.id).catch(error => {
          logger.warn(`Could not load live alert config for ${guild.id}: ${error.message}`);
          return null;
        });

        const liveAlerts = config?.liveAlerts;
        if (!liveAlerts?.enabled || !liveAlerts.channelId || !Array.isArray(liveAlerts.streamers)) {
          continue;
        }

        const channel = guild.channels.cache.get(liveAlerts.channelId);
        if (!channel?.isTextBased()) continue;

        for (const streamer of liveAlerts.streamers) {
          if (!streamer?.username) continue;
          watchers.push({ guild, channel, streamer });
        }
      }

      if (!watchers.length) return;

      const live = await this.getLiveStreams(watchers.map(w => w.streamer.username));

      for (const { guild, channel, streamer } of watchers) {
        const key = `${guild.id}:${streamer.username.toLowerCase()}`;
        const stream = live.get(streamer.username.toLowerCase());
        const wasLive = this.state.get(key) === true;
        const isLive = Boolean(stream);

        if (isLive && !wasLive) {
          this.state.set(key, true);
          await this.sendAlert(channel, streamer, stream);
        } else if (!isLive) {
          this.state.delete(key);
        }
      }
    } catch (error) {
      logger.error('Live alert polling failed:', error);
    } finally {
      this.pollInProgress = false;
    }
  }

  async sendAlert(channel, streamer, stream) {
    try {
      const permissions = channel.permissionsFor?.(this.client.user);
      if (
        permissions &&
        !permissions.has(PermissionsBitField.Flags.SendMessages)
      ) {
        logger.warn(`Missing Send Messages permission in live alert channel ${channel.id}.`);
        return;
      }

      const embed = buildLiveEmbed(streamer, stream);
      const row = buildButtons({
        ...streamer,
        twitchUrl: streamer.twitchUrl || twitchUrl(streamer.username),
      });

      const message = await channel.send({
        embeds: [embed],
        components: row ? [row] : [],
      });

      // Matches the small reaction controls shown under the reference design.
      await message.react('❤️').catch(() => {});
      await message.react('😶').catch(() => {});

      logger.info(
        `Live alert sent for ${streamer.username} in guild ${channel.guild?.id || 'unknown'}.`,
      );
    } catch (error) {
      logger.error(`Failed to send live alert for ${streamer.username}:`, error);
    }
  }

  async sendTest(channel, streamer) {
    const fakeStream = {
      title: streamer.description || 'live footage of 7 making choices',
      started_at: new Date().toISOString(),
      thumbnail_url: streamer.gifUrl || null,
    };

    const embed = buildLiveEmbed(streamer, fakeStream);
    const row = buildButtons({
      ...streamer,
      twitchUrl: streamer.twitchUrl || twitchUrl(streamer.username),
    });

    const message = await channel.send({
      embeds: [embed],
      components: row ? [row] : [],
    });

    await message.react('❤️').catch(() => {});
    await message.react('😶').catch(() => {});
    return message;
  }
}
