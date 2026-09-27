//=============================================================================
// QOL_Cyan_Border_Highlighter.js
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Draws cyan lines at the boundary between walkable and
 * non-walkable tiles. Hidden passages appear as gaps in the border lines.
 * @author Ported from VX Ace QOL_Cyan_Border_Highlighter
 *
 * @param toggleKey
 * @text Toggle Key
 * @desc Key used to toggle the overlay on/off (RPG Maker key name, e.g. F6).
 * @default F6
 *
 * @param color
 * @text Line Color
 * @desc CSS color string for the border lines (supports alpha via rgba()).
 * @default rgba(0,255,255,0.7)
 *
 * @param lineWidth
 * @text Line Width
 * @desc Width in pixels of the border lines.
 * @type number
 * @default 2
 *
 * @param defaultOn
 * @text Default On
 * @desc Whether the overlay is visible by default when a map loads.
 * @type boolean
 * @default true
 *
 * @help
 * QOL Cyan Border Highlighter (MZ port)
 * ------------------------------------------------------------------------
 * Draws cyan lines only at the boundary between walkable and non-walkable
 * tiles. Hidden passages appear as gaps in the border lines.
 *
 * Toggle key is configurable below (default F6).
 * Place load order is not relevant for MZ plugins beyond normal
 * plugin manager ordering; this plugin only aliases core methods.
 *
 * Looping maps (horizontal/vertical wrap) are supported: the overlay
 * draws extra copies of itself offset by one map-width/height so the
 * border is visible on both sides of the seam as the camera wraps.
 *
 * The overlay automatically redraws on map load, and on most in-map
 * passability changes (anything that goes through $gameMap.refresh(),
 * e.g. self-switch/switch-driven event page changes). For passability
 * changes that don't trigger a map refresh on their own — a script
 * call that pokes $gameMap's tile data directly, for instance — use
 * the "Refresh Border Overlay" plugin command to force a redraw.
 *
 * @command refresh
 * @text Refresh Border Overlay
 * @desc Forces the cyan border overlay to recompute and redraw on its next update.
 */

(() => {
  "use strict";

  const pluginName = "QOL_Cyan_Border_Highlighter";
  const params = PluginManager.parameters(pluginName);

  const TOGGLE_KEY_NAME = String(params.toggleKey || "F6");
  const COLOR = String(params.color || "rgba(0,255,255,0.7)");
  const LINE_WIDTH = Number(params.lineWidth || 2);
  const DEFAULT_ON = params.defaultOn === "true";

  // Map the configured key name to a keyCode and register it in Input's
  // keyMapper if it isn't already bound (F-keys aren't mapped by default).
  const F_KEY_CODES = {
    F5: 116, F6: 117, F7: 118, F8: 119, F9: 120
  };
  if (F_KEY_CODES[TOGGLE_KEY_NAME] !== undefined) {
    Input.keyMapper[F_KEY_CODES[TOGGLE_KEY_NAME]] = "qolBorderToggle";
  }

  //---------------------------------------------------------------------
  // Game_Map — dirty flag on every setup call
  //---------------------------------------------------------------------
  const _Game_Map_setup = Game_Map.prototype.setup;
  Game_Map.prototype.setup = function(mapId) {
    _Game_Map_setup.call(this, mapId);
    this._qolBorderDirty = true;
  };

  Game_Map.prototype.qolBorderDirty = function() {
    return this._qolBorderDirty || false;
  };

  Game_Map.prototype.qolBorderClearDirty = function() {
    this._qolBorderDirty = false;
  };

  //---------------------------------------------------------------------
  // Spriteset_Map
  //---------------------------------------------------------------------
  const _Spriteset_Map_createLowerLayer = Spriteset_Map.prototype.createLowerLayer;
  Spriteset_Map.prototype.createLowerLayer = function() {
    _Spriteset_Map_createLowerLayer.call(this);
    this.createQolBorderOverlay();
  };

  const _Spriteset_Map_update = Spriteset_Map.prototype.update;
  Spriteset_Map.prototype.update = function() {
    _Spriteset_Map_update.call(this);
    this.updateQolBorderOverlay();
  };

  const _Spriteset_Map_destroy = Spriteset_Map.prototype.destroy;
  Spriteset_Map.prototype.destroy = function(options) {
    this.disposeQolBorderOverlay();
    _Spriteset_Map_destroy.call(this, options);
  };

  Spriteset_Map.prototype.createQolBorderOverlay = function() {
    this._qolBorderVisible = DEFAULT_ON;
    this._qolBorderBitmap = null;
    this._qolBorderSprites = [];

    this.rebuildQolBorderSprites();
    if (this._qolBorderVisible) this.redrawQolBorderOverlay();
    this.syncQolBorderPosition();
  };

  // (Re)creates the set of sprites used to draw the overlay. For a
  // looping map we need extra copies offset by one full map-width
  // and/or map-height, since a single sprite can only ever appear on
  // screen once, but a wrapped camera view can straddle the seam and
  // needs the border visible on both sides of it simultaneously. All
  // copies share the same bitmap (cheap — no extra drawing happens).
  Spriteset_Map.prototype.rebuildQolBorderSprites = function() {
    for (const sprite of this._qolBorderSprites) {
      this._tilemap.removeChild(sprite);
      sprite.destroy();
    }
    this._qolBorderSprites = [];

    if (!$gameMap) return;

    const mapPw = $gameMap.width() * $gameMap.tileWidth();
    const mapPh = $gameMap.height() * $gameMap.tileHeight();
    const xOffsets = $gameMap.isLoopHorizontal() ? [-mapPw, 0, mapPw] : [0];
    const yOffsets = $gameMap.isLoopVertical() ? [-mapPh, 0, mapPh] : [0];

    for (const yOff of yOffsets) {
      for (const xOff of xOffsets) {
        const sprite = new Sprite(this._qolBorderBitmap);
        sprite.z = 8; // above tilemap, below characters' upper layer
        sprite.visible = this._qolBorderVisible;
        sprite._qolXOffset = xOff;
        sprite._qolYOffset = yOff;
        this._tilemap.addChild(sprite);
        this._qolBorderSprites.push(sprite);
      }
    }
  };

  Spriteset_Map.prototype.updateQolBorderOverlay = function() {
    if (Input.isTriggered("qolBorderToggle")) {
      this._qolBorderVisible = !this._qolBorderVisible;
      for (const sprite of this._qolBorderSprites) {
        sprite.visible = this._qolBorderVisible;
      }
      if (this._qolBorderVisible) this.redrawQolBorderOverlay();
    }

    if ($gameMap.qolBorderDirty()) {
      if (this._qolBorderBitmap) this._qolBorderBitmap.destroy();
      this._qolBorderBitmap = null;
      $gameMap.qolBorderClearDirty();
      // The new map may have different dimensions or loop settings,
      // so the wrap-copy sprite set has to be rebuilt too.
      this.rebuildQolBorderSprites();
      if (this._qolBorderVisible) this.redrawQolBorderOverlay();
    }

    if (!this._qolBorderVisible) return;

    // The overlay sprites are plain children of the Tilemap container.
    // The Tilemap container itself never translates when the map
    // scrolls — only its internal lower/upper tile layers do, via
    // their own origin-based repositioning. Everything else parented
    // to it (including Sprite_Character) has to recompute its own
    // screen position every frame from the map's current scroll
    // instead of relying on the parent to move it. We do the same
    // here so the border bitmap (drawn once, in absolute map-pixel
    // space) lines up with the tiles under the current camera view.
    this.syncQolBorderPosition();
  };

  Spriteset_Map.prototype.syncQolBorderPosition = function() {
    if (!$gameMap || !this._qolBorderSprites) return;
    const tw = $gameMap.tileWidth();
    const th = $gameMap.tileHeight();
    const baseX = -Math.round($gameMap.displayX() * tw);
    const baseY = -Math.round($gameMap.displayY() * th);
    for (const sprite of this._qolBorderSprites) {
      sprite.x = baseX + sprite._qolXOffset;
      sprite.y = baseY + sprite._qolYOffset;
    }
  };

  Spriteset_Map.prototype.redrawQolBorderOverlay = function() {
    if (!$gameMap) return;

    const tw = $gameMap.tileWidth();
    const th = $gameMap.tileHeight();
    const w = $gameMap.width();
    const h = $gameMap.height();
    const mapPw = w * tw;
    const mapPh = h * th;

    if (
      !this._qolBorderBitmap ||
      this._qolBorderBitmap.width !== mapPw ||
      this._qolBorderBitmap.height !== mapPh
    ) {
      if (this._qolBorderBitmap) this._qolBorderBitmap.destroy();
      this._qolBorderBitmap = new Bitmap(mapPw, mapPh);
      for (const sprite of this._qolBorderSprites) {
        sprite.bitmap = this._qolBorderBitmap;
      }
    } else {
      this._qolBorderBitmap.clear();
    }

    // Some plugins (e.g. RegionBase) make isPassable()'s result depend on
    // which character last checked passability — a region can block the
    // player while leaving events free to cross it. Force the subject to
    // the player before scanning so the overlay always reflects what the
    // player specifically can and can't walk through.
    if ($gameMap.setPassableSubject && $gamePlayer) {
      $gameMap.setPassableSubject($gamePlayer);
    }

    // HalfMove adds a second, independent passability layer (region ID /
    // terrain tag based "no path" zones for a specific half or corner of a
    // tile) that it checks in ADDITION to isPassable()/checkPassage(), via
    // Game_CharacterBase.prototype.isMapPassableByHalfRegionAndTag. That
    // check never touches isPassable(), so the overlay must replicate it
    // separately and AND it in, or it'll draw walls as open ground.
    const hasHalfMoveNpCheck =
      typeof $gameMap.isPassableByHalfRegionAndTag === "function" &&
      typeof $gameMap.roundHalfXWithDirection === "function" &&
      typeof $gameMap.roundHalfYWithDirection === "function" &&
      typeof Game_Map.tileUnit === "number" &&
      (!$gameSystem || !$gameSystem.canHalfMove || $gameSystem.canHalfMove());

    const halfMoveBlocked = (mx, my, d) => {
      if (!hasHalfMoveNpCheck) return false;
      const targetX = $gameMap.roundHalfXWithDirection(mx, d);
      const targetY = $gameMap.roundHalfYWithDirection(my, d);
      if (!$gameMap.isPassableByHalfRegionAndTag(targetX, targetY)) return true;
      if (!$gameMap.isPassableByHalfRegionAndTag(targetX + Game_Map.tileUnit, targetY)) return true;
      return false;
    };

    const lw = LINE_WIDTH;
    const loopH = $gameMap.isLoopHorizontal();
    const loopV = $gameMap.isLoopVertical();
    const pass = new Array(w * h * 4);

    for (let mx = 0; mx < w; mx++) {
      for (let my = 0; my < h; my++) {
        const i = (my * w + mx) * 4;
        pass[i] = $gameMap.isPassable(mx, my, 8) && !halfMoveBlocked(mx, my, 8);
        pass[i + 1] = $gameMap.isPassable(mx, my, 2) && !halfMoveBlocked(mx, my, 2);
        pass[i + 2] = $gameMap.isPassable(mx, my, 4) && !halfMoveBlocked(mx, my, 4);
        pass[i + 3] = $gameMap.isPassable(mx, my, 6) && !halfMoveBlocked(mx, my, 6);
      }
    }

    // On a looping map, the tile past the last column/row is really the
    // first column/row (and vice versa) — treat it that way so a hidden
    // passage sitting right at the seam still gets a border, instead of
    // the seam always reading as a solid wall.
    const fetch = (mx, my, d) => {
      let x = mx;
      let y = my;
      if (x < 0 || x >= w) {
        if (!loopH) return false;
        x = ((x % w) + w) % w;
      }
      if (y < 0 || y >= h) {
        if (!loopV) return false;
        y = ((y % h) + h) % h;
      }
      const i = (y * w + x) * 4;
      switch (d) {
        case 8: return pass[i];
        case 2: return pass[i + 1];
        case 4: return pass[i + 2];
        case 6: return pass[i + 3];
        default: return false;
      }
    };

    const bmp = this._qolBorderBitmap;

    for (let mx = 0; mx < w; mx++) {
      for (let my = 0; my < h; my++) {
        const px = mx * tw;
        const py = my * th;

        if (fetch(mx, my - 1, 2) !== fetch(mx, my, 8)) {
          bmp.fillRect(px, py, tw, lw, COLOR);
        }

        if (fetch(mx - 1, my, 6) !== fetch(mx, my, 4)) {
          bmp.fillRect(px, py, lw, th, COLOR);
        }

        if (mx === w - 1) {
          if (fetch(mx, my, 6) !== fetch(mx + 1, my, 4)) {
            bmp.fillRect(px + tw - lw, py, lw, th, COLOR);
          }
        }

        if (my === h - 1) {
          if (fetch(mx, my, 2) !== fetch(mx, my + 1, 8)) {
            bmp.fillRect(px, py + th - lw, tw, lw, COLOR);
          }
        }
      }
    }
  };

  Spriteset_Map.prototype.disposeQolBorderOverlay = function() {
    for (const sprite of this._qolBorderSprites || []) {
      sprite.destroy();
    }
    if (this._qolBorderBitmap) this._qolBorderBitmap.destroy();
  };
})();
