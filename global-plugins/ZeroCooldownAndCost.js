/*:
 * @plugindesc Forces all skills to have 0 MP cost (incl. Custom MP Cost evals), 0 TP cost, 0 cooldown, and turns single-target (1 Enemy) skills into All Enemies — patched in memory, Skills.json is never touched. v1.2.1
 * @author Claude
 *
 * @help ZeroCooldownAndCost.js
 * ============================================================================
 * Engine compatibility
 * ============================================================================
 * Works in both RPG Maker MV and MZ. The mpCost / tpCost / scope fields and
 * the DataManager.onLoad hook this plugin uses are identical in both engines.
 *
 * The <Custom MP Cost> and <Cooldown Eval> notetag rewrites only do
 * anything if you also have a plugin that reads those specific notetags
 * (e.g. a Yanfly/VisuStella-style skill cost or cooldown plugin). If you
 * don't use such a plugin, those two rewrites are harmless no-ops — you'll
 * still get the flat mpCost = 0, tpCost = 0, and scope 1 -> 2 changes.
 *
 * ============================================================================
 * What this does
 * ============================================================================
 * On database load, this plugin walks $dataSkills in memory and:
 *
 *   1. Sets mpCost = 0 and tpCost = 0 on every skill object.
 *
 *   2. Rewrites the body of every <Custom MP Cost> ... </Custom MP Cost>
 *      notetag block so it unconditionally sets `cost = 0;`, regardless of
 *      whatever conditional logic the original block contained (e.g. the
 *      Backstab example that added +25 MP while a state was active — cost
 *      is simply forced to 0 in all cases). This matters because a Custom
 *      MP Cost eval runs independently of the flat mpCost field at cast
 *      time, so zeroing mpCost alone would not stop it from adding cost.
 *
 *   3. Rewrites the body of every <Cooldown Eval> ... </Cooldown Eval>
 *      notetag block so it unconditionally sets `cooldown = 0;`, regardless
 *      of whatever conditional logic the original block contained (e.g. the
 *      Parry example that added +15 MP / kept a 3-turn cooldown unless a
 *      state was active — cooldown is simply forced to 0 in all cases).
 *
 *   4. Changes scope = 1 ("1 Enemy") to scope = 2 ("All Enemies") on every
 *      skill, so every single-target-enemy skill now hits all enemies.
 *      Other scopes (allies, random enemies, the user, etc.) are untouched.
 *
 * Skills.json on disk is never modified — this only edits the in-memory
 * $dataSkills array after it's loaded, every time the game boots.
 *
 * ============================================================================
 * Notes / assumptions
 * ============================================================================
 * - This assumes MP cost can be further modified by a <Custom MP Cost>
 *   notetag that some other plugin (e.g. a Yanfly/VisuStella-style skill
 *   cost system) reads from skill.note and eval()'s at runtime, starting
 *   from a `cost` variable seeded with the base mpCost. Because that read
 *   happens live off skill.note, rewriting the note text is enough — no
 *   need to know the internals of that other plugin.
 * - This assumes cooldowns are driven by a <Cooldown Eval> notetag that some
 *   other plugin (e.g. a Yanfly/VisuStella-style cooldown system) reads from
 *   skill.note and eval()'s at runtime. Because that read happens live off
 *   skill.note, rewriting the note text is enough — no need to know the
 *   internals of that other plugin.
 * - If any skill instead relies on a plain numeric <Cooldown: n> tag (no
 *   Eval block), a second regex below also zeroes that form. Remove it if
 *   you don't use that tag.
 * - Place this plugin ANYWHERE below your cooldown-system plugin in the
 *   Plugin Manager list; load order doesn't matter here since this only
 *   patches data on the database-load event, before any battle logic runs.
 *
 * ============================================================================
 * Terms
 * ============================================================================
 * Free to use and modify in any project, commercial or non-commercial.
 *
 * @param logChanges
 * @text Log Changes To Console
 * @type boolean
 * @default false
 * @desc If ON, prints a summary of how many skills were patched to the
 * dev console (F8) once the database finishes loading.
 */

(() => {
    "use strict";

    const PLUGIN_NAME = "ZeroCooldownAndCost";
    const params = PluginManager.parameters(PLUGIN_NAME);
    const logChanges = params.logChanges === "true";

    // Matches <Cooldown Eval> ... </Cooldown Eval>, across multiple lines,
    // case-insensitive, and replaces the inner body entirely.
    const COOLDOWN_EVAL_RE = /<Cooldown Eval>[\s\S]*?<\/Cooldown Eval>/gi;
    const COOLDOWN_EVAL_REPLACEMENT =
        "<Cooldown Eval>\ncooldown = 0;\n</Cooldown Eval>";

    // Optional: also catch a plain numeric tag like <Cooldown: 3>
    const COOLDOWN_FLAT_RE = /<Cooldown:\s*\d+>/gi;
    const COOLDOWN_FLAT_REPLACEMENT = "<Cooldown: 0>";

    // Matches <Custom MP Cost> ... </Custom MP Cost>, across multiple lines,
    // case-insensitive, and replaces the inner body entirely. This runs
    // independently of the flat mpCost field at cast time, so it needs the
    // same forced-to-zero treatment or a skill can still cost MP.
    const CUSTOM_MP_COST_RE = /<Custom MP Cost>[\s\S]*?<\/Custom MP Cost>/gi;
    const CUSTOM_MP_COST_REPLACEMENT =
        "<Custom MP Cost>\ncost = 0;\n</Custom MP Cost>";

    function patchSkill(skill) {
        if (!skill) return false;
        let changed = false;

        if (skill.mpCost !== 0) {
            skill.mpCost = 0;
            changed = true;
        }
        if (skill.tpCost !== 0) {
            skill.tpCost = 0;
            changed = true;
        }

        if (skill.scope === 1) {
            skill.scope = 2;
            changed = true;
        }

        if (skill.note) {
            const original = skill.note;
            let note = original.replace(CUSTOM_MP_COST_RE, CUSTOM_MP_COST_REPLACEMENT);
            note = note.replace(COOLDOWN_EVAL_RE, COOLDOWN_EVAL_REPLACEMENT);
            note = note.replace(COOLDOWN_FLAT_RE, COOLDOWN_FLAT_REPLACEMENT);
            if (note !== original) {
                skill.note = note;
                changed = true;
            }
        }

        return changed;
    }

    function patchAllSkills() {
        let patchedCount = 0;
        for (const skill of $dataSkills) {
            if (patchSkill(skill)) patchedCount++;
        }
        if (logChanges) {
            console.log(
                `[${PLUGIN_NAME}] Patched ${patchedCount} skill(s): mpCost/tpCost -> 0, Custom MP Cost -> 0, cooldown -> 0, scope 1 -> 2.`
            );
        }
    }

    const _DataManager_onLoad = DataManager.onLoad;
    DataManager.onLoad = function(object) {
        _DataManager_onLoad.call(this, object);
        if (object === $dataSkills) {
            patchAllSkills();
        }
    };
})();
