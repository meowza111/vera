// reactionRoleService.js
//
// Carl-bot-style reaction role service for discord.js v14.
//
// Stored panel format:
//
// {
//     guildId: '123456789012345678',
//     channelId: '123456789012345678',
//     messageId: '123456789012345678',
//     roles: {
//         '🎮': '123456789012345678',
//         '🎨': '987654321098765432',
//         'bell:123456789012345678': '555555555555555555'
//     },
//     mode: 'normal',
//     unique: false,
//     createdAt: '2026-09-09T00:00:00.000Z',
//     updatedAt: '2026-09-09T00:00:00.000Z'
// }

import { logger } from '../utils/logger.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import {
    getReactionRoleKey,
    getReactionRolesPrefix
} from '../utils/database/keys.js';

const MAX_ROLES_PER_MESSAGE = 25;

const VALID_MODES = new Set([
    'normal',
    'verify',
    'drop',
    'reversed'
]);

const DANGEROUS_PERMISSIONS = [
    'Administrator',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'ManageWebhooks',
    'BanMembers',
    'KickMembers'
];

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validateGuildId(guildId) {
    if (
        !guildId ||
        typeof guildId !== 'string' ||
        !/^\d{17,19}$/.test(guildId)
    ) {
        throw createError(
            `Invalid guild ID: ${guildId}`,
            ErrorTypes.VALIDATION,
            'Invalid server ID provided.',
            { guildId }
        );
    }
}

function validateMessageId(messageId) {
    if (
        !messageId ||
        typeof messageId !== 'string' ||
        !/^\d{17,19}$/.test(messageId)
    ) {
        throw createError(
            `Invalid message ID: ${messageId}`,
            ErrorTypes.VALIDATION,
            'Invalid message ID provided.',
            { messageId }
        );
    }
}

function validateChannelId(channelId) {
    if (
        !channelId ||
        typeof channelId !== 'string' ||
        !/^\d{17,19}$/.test(channelId)
    ) {
        throw createError(
            `Invalid channel ID: ${channelId}`,
            ErrorTypes.VALIDATION,
            'Invalid channel ID provided.',
            { channelId }
        );
    }
}

function validateRoleId(roleId) {
    if (
        !roleId ||
        typeof roleId !== 'string' ||
        !/^\d{17,19}$/.test(roleId)
    ) {
        throw createError(
            `Invalid role ID: ${roleId}`,
            ErrorTypes.VALIDATION,
            'Invalid role ID provided.',
            { roleId }
        );
    }
}

function validateMode(mode) {
    if (!VALID_MODES.has(mode)) {
        throw createError(
            `Invalid reaction role mode: ${mode}`,
            ErrorTypes.VALIDATION,
            `Invalid reaction role mode. Valid modes: ${[
                ...VALID_MODES
            ].join(', ')}.`,
            { mode }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Emoji helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns the database key used for an emoji.
 *
 * Unicode:
 *     🎮
 *
 * Custom Discord emoji:
 *     emojiName:emojiId
 *
 * You can pass either:
 *     '🎮'
 *     '<:gamer:123456789>'
 *     { name: 'gamer', id: '123456789' }
 */
export function normalizeEmoji(emoji) {
    if (!emoji) return null;

    if (typeof emoji === 'object') {
        if (emoji.id) {
            return `${emoji.name || 'emoji'}:${emoji.id}`;
        }

        if (emoji.name) {
            return String(emoji.name);
        }

        return null;
    }

    const value = String(emoji).trim();

    if (!value) return null;

    // <:name:id>
    const normalCustom = value.match(
        /^<:([a-zA-Z0-9_~]+):(\d{17,19})>$/
    );

    if (normalCustom) {
        return `${normalCustom[1]}:${normalCustom[2]}`;
    }

    // <a:name:id>
    const animatedCustom = value.match(
        /^<a:([a-zA-Z0-9_~]+):(\d{17,19})>$/
    );

    if (animatedCustom) {
        return `${animatedCustom[1]}:${animatedCustom[2]}`;
    }

    return value;
}

/**
 * Converts a Discord MessageReaction emoji into the same key used
 * by normalizeEmoji().
 */
export function getReactionEmojiKey(reaction) {
    if (!reaction?.emoji) return null;

    return normalizeEmoji({
        name: reaction.emoji.name,
        id: reaction.emoji.id
    });
}

/**
 * Returns a displayable emoji.
 */
export function getEmojiDisplay(emoji) {
    if (!emoji) return '❓';

    const key = normalizeEmoji(emoji);

    if (!key) return '❓';

    const match = key.match(/^(.+):(\d{17,19})$/);

    if (match) {
        return `<:${match[1]}:${match[2]}>`;
    }

    return key;
}

/* -------------------------------------------------------------------------- */
/* Role safety                                                                */
/* -------------------------------------------------------------------------- */

export function hasDangerousPermissions(role) {
    if (!role || !role.permissions) return false;

    for (const permission of DANGEROUS_PERMISSIONS) {
        if (role.permissions.has(permission)) {
            return true;
        }
    }

    return false;
}

async function getGuild(client, guildId) {
    return (
        client.guilds?.cache?.get(guildId) ||
        await client.guilds?.fetch?.(guildId).catch(() => null)
    );
}

async function getGuildRole(client, guildId, roleId) {
    const guild = await getGuild(client, guildId);

    if (!guild) {
        throw createError(
            `Guild not found: ${guildId}`,
            ErrorTypes.VALIDATION,
            'Server not found while validating the reaction role.',
            { guildId, roleId }
        );
    }

    const role =
        guild.roles.cache.get(roleId) ||
        await guild.roles.fetch(roleId).catch(() => null);

    return { guild, role };
}

async function validateRoleSafety(client, guildId, roleId) {
    validateRoleId(roleId);

    const { guild, role } = await getGuildRole(
        client,
        guildId,
        roleId
    );

    if (!role) {
        throw createError(
            `Role not found: ${roleId}`,
            ErrorTypes.VALIDATION,
            'The selected role no longer exists.',
            { guildId, roleId }
        );
    }

    if (role.id === guild.id) {
        throw createError(
            `@everyone cannot be used: ${roleId}`,
            ErrorTypes.VALIDATION,
            'The @everyone role cannot be used as a reaction role.',
            { guildId, roleId }
        );
    }

    if (role.managed) {
        throw createError(
            `Managed role cannot be used: ${roleId}`,
            ErrorTypes.VALIDATION,
            'Managed integration/bot roles cannot be used as reaction roles.',
            { guildId, roleId }
        );
    }

    if (hasDangerousPermissions(role)) {
        throw createError(
            `Dangerous role permission detected: ${roleId}`,
            ErrorTypes.PERMISSION,
            'For security reasons, high-privilege roles cannot be assigned through reaction roles.',
            {
                guildId,
                roleId,
                roleName: role.name,
                dangerousPermissions: DANGEROUS_PERMISSIONS
            }
        );
    }

    const botHighestRole = guild.members.me?.roles?.highest;

    if (!botHighestRole) {
        throw createError(
            'Bot member unavailable',
            ErrorTypes.PERMISSION,
            'I could not determine my highest role in this server.',
            { guildId, roleId }
        );
    }

    if (role.position >= botHighestRole.position) {
        throw createError(
            `Role above bot hierarchy: ${roleId}`,
            ErrorTypes.PERMISSION,
            'I cannot assign this role because it is equal to or above my highest role.',
            {
                guildId,
                roleId,
                rolePosition: role.position,
                botRolePosition: botHighestRole.position
            }
        );
    }

    return role;
}

/* -------------------------------------------------------------------------- */
/* Data normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Your old system stored:
 *
 *     roles: ['123', '456']
 *
 * Your reaction-role system needs:
 *
 *     roles: {
 *         '🎮': '123',
 *         '🎨': '456'
 *     }
 *
 * This function allows old panels to continue being read safely.
 */
function normalizePanelData(data) {
    if (!data) return null;

    const normalized = {
        guildId: data.guildId,
        channelId: data.channelId || '',
        messageId: data.messageId,
        roles: {},
        mode: VALID_MODES.has(data.mode)
            ? data.mode
            : 'normal',
        unique: Boolean(data.unique),
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: data.updatedAt || data.createdAt || new Date().toISOString()
    };

    if (Array.isArray(data.roles)) {
        /*
         * Old panels don't contain emoji mappings.
         *
         * Keep the role IDs in the special legacy list so they
         * don't get silently lost when an old panel is loaded.
         */
        normalized.legacyRoleIds = [
            ...new Set(
                data.roles.filter(
                    roleId =>
                        typeof roleId === 'string' &&
                        /^\d{17,19}$/.test(roleId)
                )
            )
        ];
    } else if (data.roles && typeof data.roles === 'object') {
        for (const [emoji, roleId] of Object.entries(data.roles)) {
            if (
                typeof roleId === 'string' &&
                /^\d{17,19}$/.test(roleId)
            ) {
                const emojiKey = normalizeEmoji(emoji);

                if (emojiKey) {
                    normalized.roles[emojiKey] = roleId;
                }
            }
        }
    }

    /*
     * Some versions may have mappings stored under reactionRoles.
     * Accept that too.
     */
    if (
        data.reactionRoles &&
        typeof data.reactionRoles === 'object'
    ) {
        for (const [emoji, roleId] of Object.entries(
            data.reactionRoles
        )) {
            if (
                typeof roleId === 'string' &&
                /^\d{17,19}$/.test(roleId)
            ) {
                const emojiKey = normalizeEmoji(emoji);

                if (emojiKey) {
                    normalized.roles[emojiKey] = roleId;
                }
            }
        }
    }

    return normalized;
}

function serializePanelData(data) {
    const normalized = normalizePanelData(data);

    if (!normalized) return null;

    return {
        guildId: normalized.guildId,
        channelId: normalized.channelId,
        messageId: normalized.messageId,
        roles: normalized.roles,
        mode: normalized.mode,
        unique: normalized.unique,
        createdAt: normalized.createdAt,
        updatedAt: new Date().toISOString()
    };
}

/* -------------------------------------------------------------------------- */
/* Panel retrieval                                                            */
/* -------------------------------------------------------------------------- */

export async function getReactionRoleMessage(
    client,
    guildId,
    messageId
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);

        const key = getReactionRoleKey(
            guildId,
            messageId
        );

        const data = await client.db.get(key);

        if (!data) return null;

        const actualData =
            data?.ok && data.value
                ? data.value
                : data?.value
                    ? data.value
                    : data;

        return normalizePanelData(actualData);

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error getting reaction role message ${messageId} in guild ${guildId}:`,
            error
        );

        throw createError(
            'Database error retrieving reaction role message',
            ErrorTypes.DATABASE,
            'Failed to retrieve reaction role data. Please try again.',
            {
                guildId,
                messageId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Panel creation                                                             */
/* -------------------------------------------------------------------------- */

export async function createReactionRoleMessage(
    client,
    guildId,
    channelId,
    messageId,
    roleIds = [],
    options = {}
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        validateChannelId(channelId);

        if (!Array.isArray(roleIds)) {
            throw createError(
                'Invalid roles',
                ErrorTypes.VALIDATION,
                'Roles must be provided as an array.',
                { roleIds }
            );
        }

        if (roleIds.length > MAX_ROLES_PER_MESSAGE) {
            throw createError(
                `Too many roles: ${roleIds.length}`,
                ErrorTypes.VALIDATION,
                `You can only have ${MAX_ROLES_PER_MESSAGE} reaction roles per panel.`,
                {
                    count: roleIds.length,
                    limit: MAX_ROLES_PER_MESSAGE
                }
            );
        }

        const uniqueRoleIds = [
            ...new Set(roleIds)
        ];

        for (const roleId of uniqueRoleIds) {
            await validateRoleSafety(
                client,
                guildId,
                roleId
            );
        }

        const mode = options.mode || 'normal';

        validateMode(mode);

        const reactionRoleData = {
            guildId,
            channelId,
            messageId,

            roles: {},

            mode,
            unique: Boolean(options.unique),

            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        /*
         * Keep legacyRoleIds only when the caller is still using
         * the old setup command.
         *
         * This prevents existing setup panels from losing their
         * role information while you migrate them.
         */
        if (uniqueRoleIds.length > 0) {
            reactionRoleData.legacyRoleIds =
                uniqueRoleIds;
        }

        const key = getReactionRoleKey(
            guildId,
            messageId
        );

        await client.db.set(
            key,
            reactionRoleData
        );

        logger.info(
            `Created reaction role panel ${messageId} in guild ${guildId}`
        );

        return reactionRoleData;

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error creating reaction role message in guild ${guildId}:`,
            error
        );

        throw createError(
            'Database error creating reaction role message',
            ErrorTypes.DATABASE,
            'Failed to save reaction role data. Please try again.',
            {
                guildId,
                messageId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Add emoji → role                                                           */
/* -------------------------------------------------------------------------- */

export async function addReactionRole(
    client,
    guildId,
    messageId,
    emoji,
    roleId
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        validateRoleId(roleId);

        const emojiKey = normalizeEmoji(emoji);

        if (!emojiKey) {
            throw createError(
                'Invalid emoji',
                ErrorTypes.VALIDATION,
                'A valid emoji is required.',
                { emoji }
            );
        }

        const role = await validateRoleSafety(
            client,
            guildId,
            roleId
        );

        const existing =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!existing) {
            throw createError(
                'Reaction role panel not found',
                ErrorTypes.CONFIGURATION,
                'That message is not configured as a reaction role panel.',
                {
                    guildId,
                    messageId
                }
            );
        }

        const data = normalizePanelData(
            existing
        );

        const currentMappings =
            Object.entries(data.roles);

        /*
         * Don't allow the same role to be mapped to
         * multiple emojis unless you explicitly want that.
         *
         * Carl-bot can be configured in different ways,
         * but this default is much safer.
         */
        const existingRoleMapping =
            currentMappings.find(
                ([, existingRoleId]) =>
                    existingRoleId === roleId &&
                    normalizeEmoji(emoji) !==
                        normalizeEmoji(
                            currentMappings.find(
                                ([key]) =>
                                    data.roles[key] === roleId
                            )?.[0]
                        )
            );

        if (existingRoleMapping) {
            throw createError(
                'Role already mapped',
                ErrorTypes.VALIDATION,
                `${role} is already assigned to another reaction on this panel.`,
                {
                    roleId,
                    existingEmoji:
                        existingRoleMapping[0]
                }
            );
        }

        if (
            !Object.prototype.hasOwnProperty.call(
                data.roles,
                emojiKey
            ) &&
            Object.keys(data.roles).length >=
                MAX_ROLES_PER_MESSAGE
        ) {
            throw createError(
                'Reaction role limit reached',
                ErrorTypes.VALIDATION,
                `This panel already has the maximum of ${MAX_ROLES_PER_MESSAGE} reaction roles.`,
                {
                    limit: MAX_ROLES_PER_MESSAGE
                }
            );
        }

        data.roles[emojiKey] = roleId;

        /*
         * Remove the old role-only representation once the
         * panel starts receiving proper emoji mappings.
         */
        delete data.legacyRoleIds;

        data.updatedAt =
            new Date().toISOString();

        const key = getReactionRoleKey(
            guildId,
            messageId
        );

        await client.db.set(
            key,
            serializePanelData(data)
        );

        logger.info(
            `Added reaction role ${emojiKey} -> ${role.name} (${roleId}) to message ${messageId}`
        );

        return {
            emoji: emojiKey,
            roleId,
            role
        };

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error adding reaction role in guild ${guildId}:`,
            error
        );

        throw createError(
            'Database error adding reaction role',
            ErrorTypes.DATABASE,
            'Failed to add reaction role. Please try again.',
            {
                guildId,
                messageId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Remove emoji → role                                                        */
/* -------------------------------------------------------------------------- */

export async function removeReactionRole(
    client,
    guildId,
    messageId,
    emoji
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);

        const emojiKey =
            normalizeEmoji(emoji);

        if (!emojiKey) {
            return false;
        }

        const data =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!data) return false;

        if (
            !Object.prototype.hasOwnProperty.call(
                data.roles,
                emojiKey
            )
        ) {
            return false;
        }

        const removedRoleId =
            data.roles[emojiKey];

        delete data.roles[emojiKey];

        data.updatedAt =
            new Date().toISOString();

        const key = getReactionRoleKey(
            guildId,
            messageId
        );

        /*
         * Keep the panel in the database even when the
         * last mapping is removed. The dashboard can then
         * still manage/repost the panel.
         */
        await client.db.set(
            key,
            serializePanelData(data)
        );

        logger.info(
            `Removed reaction role ${emojiKey} -> ${removedRoleId} from message ${messageId}`
        );

        return {
            emoji: emojiKey,
            roleId: removedRoleId
        };

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error removing reaction role in guild ${guildId}:`,
            error
        );

        throw createError(
            'Database error removing reaction role',
            ErrorTypes.DATABASE,
            'Failed to remove reaction role. Please try again.',
            {
                guildId,
                messageId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Get mapping                                                                */
/* -------------------------------------------------------------------------- */

export async function getReactionRole(
    client,
    guildId,
    messageId,
    emoji
) {
    const data =
        await getReactionRoleMessage(
            client,
            guildId,
            messageId
        );

    if (!data) return null;

    const emojiKey =
        normalizeEmoji(emoji);

    if (!emojiKey) return null;

    const roleId =
        data.roles?.[emojiKey];

    if (!roleId) return null;

    return {
        emoji: emojiKey,
        roleId,
        mode: data.mode || 'normal',
        unique: Boolean(data.unique)
    };
}

/* -------------------------------------------------------------------------- */
/* Get all mappings                                                           */
/* -------------------------------------------------------------------------- */

export async function getReactionRoleMappings(
    client,
    guildId,
    messageId
) {
    const data =
        await getReactionRoleMessage(
            client,
            guildId,
            messageId
        );

    if (!data) return [];

    return Object.entries(
        data.roles || {}
    ).map(([emoji, roleId]) => ({
        emoji,
        roleId
    }));
}

/* -------------------------------------------------------------------------- */
/* Set mode                                                                   */
/* -------------------------------------------------------------------------- */

export async function setReactionRoleMode(
    client,
    guildId,
    messageId,
    mode
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        validateMode(mode);

        const data =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!data) {
            throw createError(
                'Panel not found',
                ErrorTypes.CONFIGURATION,
                'That reaction role panel does not exist.',
                {
                    guildId,
                    messageId
                }
            );
        }

        data.mode = mode;
        data.updatedAt =
            new Date().toISOString();

        await client.db.set(
            getReactionRoleKey(
                guildId,
                messageId
            ),
            serializePanelData(data)
        );

        logger.info(
            `Set reaction role mode for ${messageId} to ${mode}`
        );

        return data;

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error setting reaction role mode:`,
            error
        );

        throw createError(
            'Database error setting reaction role mode',
            ErrorTypes.DATABASE,
            'Failed to update the reaction role mode.',
            {
                guildId,
                messageId,
                mode,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Set unique mode                                                            */
/* -------------------------------------------------------------------------- */

export async function setReactionRoleUnique(
    client,
    guildId,
    messageId,
    unique
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);

        const data =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!data) {
            throw createError(
                'Panel not found',
                ErrorTypes.CONFIGURATION,
                'That reaction role panel does not exist.',
                {
                    guildId,
                    messageId
                }
            );
        }

        data.unique = Boolean(unique);
        data.updatedAt =
            new Date().toISOString();

        await client.db.set(
            getReactionRoleKey(
                guildId,
                messageId
            ),
            serializePanelData(data)
        );

        return data;

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error setting unique reaction roles:`,
            error
        );

        throw createError(
            'Database error setting unique reaction roles',
            ErrorTypes.DATABASE,
            'Failed to update unique reaction role settings.',
            {
                guildId,
                messageId,
                unique,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Set channel                                                                */
/* -------------------------------------------------------------------------- */

export async function setReactionRoleChannel(
    client,
    guildId,
    messageId,
    channelId
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);
        validateChannelId(channelId);

        const data =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!data) {
            throw createError(
                'Panel not found',
                ErrorTypes.CONFIGURATION,
                'That reaction role panel does not exist.',
                {
                    guildId,
                    messageId
                }
            );
        }

        data.channelId = channelId;
        data.updatedAt =
            new Date().toISOString();

        await client.db.set(
            getReactionRoleKey(
                guildId,
                messageId
            ),
            serializePanelData(data)
        );

        logger.info(
            `Set channel ${channelId} for reaction role message ${messageId}`
        );

        return true;

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error setting channel for reaction role message ${messageId}:`,
            error
        );

        throw createError(
            'Database error setting reaction role channel',
            ErrorTypes.DATABASE,
            'Failed to update the reaction role channel.',
            {
                guildId,
                messageId,
                channelId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Delete panel                                                               */
/* -------------------------------------------------------------------------- */

export async function deleteReactionRoleMessage(
    client,
    guildId,
    messageId
) {
    try {
        validateGuildId(guildId);
        validateMessageId(messageId);

        const key =
            getReactionRoleKey(
                guildId,
                messageId
            );

        const data =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!data) {
            logger.debug(
                `Reaction role message ${messageId} does not exist in guild ${guildId}`
            );

            return true;
        }

        await client.db.delete(key);

        logger.info(
            `Deleted reaction role message ${messageId} in guild ${guildId}`
        );

        return true;

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error deleting reaction role message in guild ${guildId}:`,
            error
        );

        throw createError(
            'Database error deleting reaction role message',
            ErrorTypes.DATABASE,
            'Failed to delete reaction role message.',
            {
                guildId,
                messageId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Get all panels                                                             */
/* -------------------------------------------------------------------------- */

export async function getAllReactionRoleMessages(
    client,
    guildId
) {
    try {
        validateGuildId(guildId);

        const prefix =
            getReactionRolesPrefix(guildId);

        let keys;

        try {
            keys = await client.db.list(prefix);

            if (
                keys &&
                typeof keys === 'object'
            ) {
                if (Array.isArray(keys)) {
                    // already correct
                } else if (
                    Array.isArray(keys.value)
                ) {
                    keys = keys.value;
                } else {
                    const allKeys =
                        await client.db.list();

                    if (Array.isArray(allKeys)) {
                        keys = allKeys.filter(
                            key =>
                                key.startsWith(prefix)
                        );
                    } else if (
                        Array.isArray(
                            allKeys?.value
                        )
                    ) {
                        keys =
                            allKeys.value.filter(
                                key =>
                                    key.startsWith(
                                        prefix
                                    )
                            );
                    } else {
                        return [];
                    }
                }
            } else {
                return [];
            }

        } catch (listError) {
            logger.error(
                `Error listing reaction role keys for guild ${guildId}:`,
                listError
            );

            throw createError(
                'Database error listing reaction roles',
                ErrorTypes.DATABASE,
                'Failed to retrieve reaction role panels.',
                {
                    guildId,
                    originalError:
                        listError.message
                }
            );
        }

        if (!keys?.length) {
            return [];
        }

        const messages = [];

        for (const key of keys) {
            try {
                const raw =
                    await client.db.get(key);

                if (!raw) continue;

                const actualData =
                    raw?.ok && raw.value
                        ? raw.value
                        : raw?.value
                            ? raw.value
                            : raw;

                if (
                    actualData?.messageId &&
                    actualData?.channelId
                ) {
                    messages.push(
                        normalizePanelData(
                            actualData
                        )
                    );
                }

            } catch (dataError) {
                logger.warn(
                    `Error reading reaction role key ${key}:`,
                    dataError
                );
            }
        }

        return messages;

    } catch (error) {
        if (error.name === 'TitanBotError') {
            throw error;
        }

        logger.error(
            `Error getting all reaction role messages for guild ${guildId}:`,
            error
        );

        throw createError(
            'Database error retrieving reaction roles',
            ErrorTypes.DATABASE,
            'Failed to retrieve reaction role panels.',
            {
                guildId,
                originalError: error.message
            }
        );
    }
}

/* -------------------------------------------------------------------------- */
/* Reconcile panels                                                           */
/* -------------------------------------------------------------------------- */

export async function reconcileReactionRoleMessages(
    client,
    guildId = null
) {
    const summary = {
        scannedGuilds: 0,
        scannedMessages: 0,
        removedMessages: 0,
        errors: 0
    };

    try {
        const targetGuildIds =
            guildId
                ? [guildId]
                : Array.from(
                      client.guilds.cache.keys()
                  );

        for (const targetGuildId of targetGuildIds) {
            summary.scannedGuilds += 1;

            let panels = [];

            try {
                panels =
                    await getAllReactionRoleMessages(
                        client,
                        targetGuildId
                    );
            } catch (error) {
                summary.errors += 1;

                logger.warn(
                    `Failed to fetch reaction role panels for guild ${targetGuildId}:`,
                    error
                );

                continue;
            }

            if (!panels.length) continue;

            const guild =
                client.guilds.cache.get(
                    targetGuildId
                ) ||
                await client.guilds
                    .fetch(targetGuildId)
                    .catch(() => null);

            if (!guild) {
                for (const panel of panels) {
                    summary.scannedMessages += 1;

                    await client.db.delete(
                        getReactionRoleKey(
                            targetGuildId,
                            panel.messageId
                        )
                    );

                    summary.removedMessages += 1;
                }

                continue;
            }

            for (const panel of panels) {
                summary.scannedMessages += 1;

                try {
                    const channel =
                        guild.channels.cache.get(
                            panel.channelId
                        ) ||
                        await guild.channels
                            .fetch(panel.channelId)
                            .catch(
                                () => null
                            );

                    if (
                        !channel ||
                        !channel.isTextBased?.()
                    ) {
                        await client.db.delete(
                            getReactionRoleKey(
                                targetGuildId,
                                panel.messageId
                            )
                        );

                        summary.removedMessages += 1;
                        continue;
                    }

                    const message =
                        await channel.messages
                            .fetch(
                                panel.messageId
                            )
                            .catch(
                                () => null
                            );

                    if (!message) {
                        await client.db.delete(
                            getReactionRoleKey(
                                targetGuildId,
                                panel.messageId
                            )
                        );

                        summary.removedMessages += 1;
                    }

                } catch (messageError) {
                    summary.errors += 1;

                    logger.warn(
                        `Failed to validate reaction role message ${panel.messageId}:`,
                        messageError
                    );
                }
            }
        }

        logger.info(
            `Reaction role reconciliation complete: scanned ${summary.scannedMessages} message(s) across ${summary.scannedGuilds} guild(s), removed ${summary.removedMessages}, errors ${summary.errors}`
        );

        return summary;

    } catch (error) {
        logger.error(
            'Unexpected error during reaction role reconciliation:',
            error
        );

        summary.errors += 1;

        return summary;
    }
}

/* -------------------------------------------------------------------------- */
/* Utility: migrate old role array                                            */
/* -------------------------------------------------------------------------- */

/**
 * Converts an old panel:
 *
 * roles: ['123', '456']
 *
 * into an empty emoji mapping while preserving the role IDs.
 *
 * You still need to assign emojis to those roles afterwards.
 */
export async function migrateReactionRolePanel(
    client,
    guildId,
    messageId
) {
    try {
        const data =
            await getReactionRoleMessage(
                client,
                guildId,
                messageId
            );

        if (!data) return null;

        const key =
            getReactionRoleKey(
                guildId,
                messageId
            );

        await client.db.set(
            key,
            serializePanelData(data)
        );

        logger.info(
            `Migrated reaction role panel ${messageId} in guild ${guildId}`
        );

        return data;

    } catch (error) {
        logger.error(
            `Failed to migrate reaction role panel ${messageId}:`,
            error
        );

        throw error;
    }
}
