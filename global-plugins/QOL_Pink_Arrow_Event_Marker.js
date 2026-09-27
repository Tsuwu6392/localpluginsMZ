//=============================================================================
// QOL_Pink_Arrow_Event_Marker.js
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Draws a bright pink neon downward "V" arrow over map events
 * whose current page uses the Action Button trigger.
 * @author Ported from VX Ace Pink Arrow Event Marker (v1.1.0)
 *
 * @param color
 * @text Arrow Color
 * @desc CSS color string for the arrow's bright pink fill.
 * @default rgba(255,45,230,1)
 *
 * @param outlineColor
 * @text Outline Color
 * @desc CSS color string for the arrow's outline.
 * @default rgba(0,0,0,1)
 *
 * @param thickness
 * @text Line Thickness
 * @desc Thickness of the pink stroke itself, in pixels (not counting the outline).
 * @type number
 * @default 2
 *
 * @param outlineThickness
 * @text Outline Thickness
 * @desc Thickness of the black outline on each side of the pink stroke, in pixels.
 * @type number
 * @default 1
 *
 * @param arrowWidth
 * @text Arrow Width
 * @desc Half-width of the V at its top, in pixels.
 * @type number
 * @default 6
 *
 * @param arrowHeight
 * @text Arrow Height
 * @desc Rows from tip to top of the V, in pixels.
 * @type number
 * @default 6
 *
 * @param gap
 * @text Gap
 * @desc Gap between the arrow tip and the event's top pixel.
 * @type number
 * @default 1
 *
 * @param zOffset
 * @text Z Offset
 * @desc Drawn this far above the character's own z.
 * @type number
 * @default 1
 *
 * @help
 * QOL Pink Arrow Event Marker (MZ port)
 * ------------------------------------------------------------------------
 * Marks every event whose current page uses the Action Button trigger
 * with a bright pink downward "V" arrow (outlined in black, hollow in
 * the middle), one pixel above the event, so action-button
 * interactables are visible at a glance.
 *
 * No setup needed; every qualifying event is marked automatically.
 * Adjust the plugin parameters above to taste.
 */

(() => {
  "use strict";

  const pluginName = "QOL_Pink_Arrow_Event_Marker";
  const params = PluginManager.parameters(pluginName);

  const COLOR = String(params.color || "rgba(255,45,230,1)");
  const OUTLINE_COLOR = String(params.outlineColor || "rgba(0,0,0,1)");
  const THICKNESS = Number(params.thickness || 2);
  const OUTLINE_THICKNESS = Number(params.outlineThickness || 1);
  const ARROW_WIDTH = Number(params.arrowWidth || 6);
  const ARROW_HEIGHT = Number(params.arrowHeight || 6);
  const GAP = Number(params.gap || 1);
  const Z_OFFSET = Number(params.zOffset || 1);

  //---------------------------------------------------------------------
  // Game_Event — expose trigger/list as public readers, matching the
  // Ace version's defensive approach (MZ's own methods are camelCase
  // and don't collide with these names, but we define our own to avoid
  // any future core changes breaking this plugin).
  //---------------------------------------------------------------------
  if (!Game_Event.prototype.qolTrigger) {
    Game_Event.prototype.qolTrigger = function() {
      const page = this.page();
      return page ? page.trigger : -1;
    };
  }
  if (!Game_Event.prototype.qolList) {
    Game_Event.prototype.qolList = function() {
      const page = this.page();
      return page ? page.list : null;
    };
  }

  //---------------------------------------------------------------------
  // Sprite_QolEventMarker
  //---------------------------------------------------------------------
  class Sprite_QolEventMarker extends Sprite {
    initialize(event) {
      super.initialize();
      this._event = event;
      this.bitmap = new Bitmap(32, 32);
      this.drawArrow();
      this.z = 0;
      this.update();
    }

    drawArrow() {
      const cx = 16;
      const gap = GAP;
      const tipY = 32 - gap - 1;
      const topY = tipY - ARROW_HEIGHT;
      const halfWidth = ARROW_WIDTH;

      const ctx = this.bitmap.context;
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Trace the V path once; we stroke it twice (wide/black, then
      // narrow/pink) so only a thin black ring shows on either side of
      // the pink line, leaving the shape itself hollow rather than a
      // solid-filled wedge.
      const tracePath = () => {
        ctx.beginPath();
        ctx.moveTo(cx - halfWidth, topY);
        ctx.lineTo(cx, tipY);
        ctx.lineTo(cx + halfWidth, topY);
      };

      // Black outline pass (wider stroke, drawn first/underneath).
      tracePath();
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = THICKNESS + OUTLINE_THICKNESS * 2;
      ctx.stroke();

      // Bright pink pass on top (narrower stroke), leaving an even
      // black ring visible along both edges of the chevron.
      tracePath();
      ctx.strokeStyle = COLOR;
      ctx.lineWidth = THICKNESS;
      ctx.stroke();

      ctx.restore();

      // Tell the engine the pixels changed so the GPU texture is
      // re-uploaded. _setDirty() isn't reliably public across MZ
      // builds, so fall back to touching baseTexture directly.
      if (typeof this.bitmap._setDirty === "function") {
        this.bitmap._setDirty();
      } else if (this.bitmap.baseTexture) {
        this.bitmap.baseTexture.update();
      }
    }

    actionable() {
      if (!this._event) return false;
      const list = this._event.qolList();
      if (!list || list.length === 0) return false;
      return this._event.qolTrigger() === 0;
    }

    update() {
      super.update();
      this.visible = this.actionable();
      if (!this.visible) return;
      this.x = this._event.screenX() - 16;
      this.y = this._event.screenY() - 32;
      this.z = this._event.screenZ() + Z_OFFSET;
      this.opacity = this._event.opacity();
    }
  }

  //---------------------------------------------------------------------
  // Spriteset_Map — hook marker creation/update/disposal into the
  // existing character sprite lifecycle.
  //---------------------------------------------------------------------
  const _Spriteset_Map_createCharacters = Spriteset_Map.prototype.createCharacters;
  Spriteset_Map.prototype.createCharacters = function() {
    _Spriteset_Map_createCharacters.call(this);
    this.createQolEventMarkers();
  };

  Spriteset_Map.prototype.createQolEventMarkers = function() {
    this._qolEventMarkers = [];
    for (const event of $gameMap.events()) {
      const marker = new Sprite_QolEventMarker(event);
      this._qolEventMarkers.push(marker);
      this._tilemap.addChild(marker);
    }
  };

  const _Spriteset_Map_updateCharacters = Spriteset_Map.prototype.updateCharacters;
  Spriteset_Map.prototype.updateCharacters = function() {
    _Spriteset_Map_updateCharacters.call(this);
    if (this._qolEventMarkers) {
      for (const marker of this._qolEventMarkers) marker.update();
    }
  };

  const _Spriteset_Map_destroy = Spriteset_Map.prototype.destroy;
  Spriteset_Map.prototype.destroy = function(options) {
    if (this._qolEventMarkers) {
      for (const marker of this._qolEventMarkers) marker.destroy();
      this._qolEventMarkers = [];
    }
    _Spriteset_Map_destroy.call(this, options);
  };
})();
