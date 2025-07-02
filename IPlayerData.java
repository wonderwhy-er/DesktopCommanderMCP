package net.itsthesky.terrawars.api.model.player;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Interface representing a player's persistent data and settings.
 * Manages player statistics, achievements, and preferences.
 */
public interface IPlayerData {

    /**
     * Get the player's unique identifier.
     *
     * @return The player's unique identifier (UUID)
     */
    @NotNull UUID getPlayerId();

    /**
     * Get the player's display name.
     *
     * @return The player's display name
     */
    @NotNull String getPlayerName();

    /**
     * Set the player's username.
     *
     * @param username The new username
     */
    void setUsername(@NotNull String username);

    /**
     * Get all statistics for this player.
     *
     * @return Map of statistic keys to values
     */
    @NotNull Map<PlayerStats, Integer> getStatistics();

    /**
     * Get a specific statistic value.
     *
     * @param stat The statistic to retrieve
     * @return The statistic value, or 0 if not found
     */
    int getStatistic(@NotNull PlayerStats stat);

    /**
     * Increment a statistic value.
     *
     * @param stat The statistic to increment
     * @param amount The amount to increment by
     */
    void incrementStatistic(@NotNull PlayerStats stat, int amount);

    /**
     * Increment a statistic value by 1.
     * @param stat The statistic to increment
     */
    default void incrementStatistic(@NotNull PlayerStats stat) {
        incrementStatistic(stat, 1);
    }

    /**
     * Get the unlock time for an achievement.
     *
     * @param achievementId The achievement ID
     * @return The instant when the achievement was unlocked, or null if not unlocked
     */
    @Nullable Instant getAchievementUnlockTime(@NotNull PlayerAchievement achievementId);


    /**
     * Get all unlocked achievements.
     *
     * @return Set of achievement IDs
     */
    @NotNull Set<PlayerAchievement> getAchievements();

    /**
     * Check if the player has a specific achievement.
     *
     * @param achievementId The achievement ID
     * @return True if the player has the achievement
     */
    boolean hasAchievement(@NotNull PlayerAchievement achievementId);

    /**
     * Unlock an achievement for the player.
     *
     * @param achievementId The achievement ID
     * @param notify Whether to notify the player about the unlock
     */
    void unlockAchievement(@NotNull PlayerAchievement achievementId, boolean notify);

    /**
     * Get all player settings as key-value pairs.
     *
     * @return Map of setting keys to values
     */
    @NotNull Map<String, Object> getSettings();

    /**
     * Get a specific setting value.
     *
     * @param key The setting key
     * @param defaultValue The default value if the setting is not found
     * @return The setting value, or defaultValue if not found
     */
    @Nullable <T> T getSetting(@NotNull String key, @Nullable T defaultValue);

    /**
     * Update a player setting.
     *
     * @param key The setting key
     * @param value The new value
     */
    void updateSetting(@NotNull String key, @NotNull Object value);
}