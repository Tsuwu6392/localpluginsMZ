//=============================================================================
// Utility.js
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Miscellaneous compatibility patches for specific plugins. v1.0.0
 * @author Claude
 *
 * @help Utility.js
 *
 * This plugin bundles small, targeted overrides/patches for other specific
 * plugins. It does nothing unless the relevant target plugin is detected.
 *
 * Place this plugin BELOW the plugins it patches in the Plugin Manager list.
 *
 * ----------------------------------------------------------------------------
 * Patch 1: SkillTree.js - selectNodeOpen()
 * ----------------------------------------------------------------------------
 * Original behavior: opening a skill tree node SUBTRACTS its SP cost.
 * Patched behavior:   opening a skill tree node ADDS its SP cost instead.
 *
 * Written against a version of SkillTree.js where SkillTreeManager.
 * selectNodeOpen() reads:
 *
 *   selectNodeOpen() {
 *       this._selectNode.open();
 *       $skillTreeData.gainSp(this._actorId, -this._selectNode.needSp());
 *   }
 *
 * SkillTreeManager is declared inside SkillTree.js's own IIFE and is not a
 * bare global; it is only reachable from outside via the alias object the
 * plugin exposes: SkillTreeClassAlias.SkillTreeManager. This patch goes
 * through that alias rather than the bare class name.
 *
 * If a future version of SkillTree.js changes this method beyond the sign
 * flip on the gainSp argument, this override will silently drop whatever
 * else was added, since it replaces the whole method body.
 *
 * ----------------------------------------------------------------------------
 * Patch 2: MPP_MapLight.js - setupMapLightCommand()
 * ----------------------------------------------------------------------------
 * After the plugin sets up map lighting/darkness from notetags as usual,
 * this forces darkness to 0 on every map, overriding any "Darkness"
 * notetag value.
 *
 */

(() => {
    'use strict';

    //-------------------------------------------------------------------------
    // Patch 1: SkillTree.js - flip SP gain/loss on node open
    //-------------------------------------------------------------------------
    if (typeof SkillTreeClassAlias !== 'undefined' && SkillTreeClassAlias.SkillTreeManager) {
        SkillTreeClassAlias.SkillTreeManager.prototype.selectNodeOpen = function() {
            this._selectNode.open();
            $skillTreeData.gainSp(this._actorId, this._selectNode.needSp());
        };
    }

    //-------------------------------------------------------------------------
    // Patch 2: MPP_MapLight.js - force darkness to 0 on every map
    //-------------------------------------------------------------------------
    if (typeof Game_Map !== 'undefined' && Game_Map.prototype.setupMapLightCommand) {
        const _Game_Map_setupMapLightCommand = Game_Map.prototype.setupMapLightCommand;
        Game_Map.prototype.setupMapLightCommand = function() {
            _Game_Map_setupMapLightCommand.apply(this, arguments);
            this.setDarkness(0);
        };
    }

})();
