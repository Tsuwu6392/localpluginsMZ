//=============================================================================
// InvertedShopping.js
//=============================================================================
/*:
 * @target MV MZ
 * @plugindesc Gold is inverted game-wide: anything that would cost gold pays it instead. Exceptions are opt-out.
 * @author You
 *
 * @param switchId
 * @text Toggle Switch ID
 * @type switch
 * @desc Inversion only works while this switch is ON. 0 = always active.
 * @default 0
 *
 * @param invertShops
 * @text Invert Shop Purchases
 * @type boolean
 * @desc Buying in shop scenes adds gold instead of subtracting it.
 * @default true
 *
 * @param exceptions
 * @text Exceptions
 * @type string
 * @desc Events that keep normal gold. Comma-separated. "41" = whole map 41, "41:3" = event 3 on map 41. Example: 41:3, 12
 * @default
 *
 * @param exceptionTag
 * @text Exception Tag
 * @type string
 * @desc A Comment containing this tag in an event page (or common event) makes it behave normally.
 * @default <NormalGold>
 *
 * @help
 * Gold is inverted everywhere by default.
 *
 * SHOPS
 *   Buying adds the price to your gold. No gold is needed to buy, so only
 *   the item cap limits quantity. Selling is unchanged.
 *
 * EVENTS (inns, etc.)
 *   - "Change Gold: Decrease" becomes an increase. "Increase" is left
 *     alone, so rewards never take gold away.
 *   - "Conditional Branch: Gold >= N" always passes. Other gold
 *     comparisons (<=, <) are left alone.
 *   - Common events called from an event follow that event's setting.
 *
 * EXCEPTIONS (events that should keep normal gold)
 *   1) Exceptions parameter: "41" for a whole map, "41:3" for one event.
 *      No map files get touched.
 *   2) Or add a Comment command containing the Exception Tag
 *      (default <NormalGold>) to the event page / common event.
 *
 * No plugin commands. Name this file InvertedShopping.js.
 */

(() => {
    "use strict";

    const params = PluginManager.parameters("InvertedShopping");
    const switchId = Number(params.switchId || 0);
    const invertShops = params.invertShops !== "false";
    const exceptionTag = String(params.exceptionTag || "<NormalGold>").toLowerCase();

    const exceptions = String(params.exceptions || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
            const parts = s.split(":");
            return {
                mapId: Number(parts[0]),
                eventId: parts.length > 1 ? Number(parts[1]) : 0
            };
        })
        .filter(t => t.mapId > 0);

    const isActive = () => switchId === 0 || $gameSwitches.value(switchId);

    //-------------------------------------------------------------------------
    // Shops
    //-------------------------------------------------------------------------
    const shopOn = () => invertShops && isActive();

    const _doBuy = Scene_Shop.prototype.doBuy;
    Scene_Shop.prototype.doBuy = function(number) {
        if (!shopOn()) return _doBuy.call(this, number);
        $gameParty.gainGold(number * this.buyingPrice());
        $gameParty.gainItem(this._item, number);
    };

    const _maxBuy = Scene_Shop.prototype.maxBuy;
    Scene_Shop.prototype.maxBuy = function() {
        if (!shopOn()) return _maxBuy.call(this);
        return $gameParty.maxItems(this._item) - $gameParty.numItems(this._item);
    };

    const _isEnabled = Window_ShopBuy.prototype.isEnabled;
    Window_ShopBuy.prototype.isEnabled = function(item) {
        if (!shopOn()) return _isEnabled.call(this, item);
        return !!item && !$gameParty.hasMaxItems(item);
    };

    //-------------------------------------------------------------------------
    // Events
    //-------------------------------------------------------------------------
    const tagCache = new WeakMap();

    const listHasTag = list => {
        if (!list) return false;
        if (!tagCache.has(list)) {
            const found = list.some(cmd =>
                (cmd.code === 108 || cmd.code === 408) &&
                String(cmd.parameters[0]).toLowerCase().includes(exceptionTag));
            tagCache.set(list, found);
        }
        return tagCache.get(list);
    };

    Game_Interpreter.prototype.isGoldException = function() {
        if (this._goldException) return true;
        if (listHasTag(this._list)) return true;
        return exceptions.some(t => t.mapId === this._mapId &&
            (t.eventId === 0 || t.eventId === this._eventId));
    };

    Game_Interpreter.prototype.isInvertGold = function() {
        return isActive() && !this.isGoldException();
    };

    // Common events called from an exempt event stay exempt.
    const _setupChild = Game_Interpreter.prototype.setupChild;
    Game_Interpreter.prototype.setupChild = function(list, eventId) {
        _setupChild.call(this, list, eventId);
        if (this._childInterpreter) {
            this._childInterpreter._goldException = this.isGoldException();
        }
    };

    // Change Gold: a decrease becomes an increase. Increases are left alone.
    const _command125 = Game_Interpreter.prototype.command125;
    Game_Interpreter.prototype.command125 = function(p) {
        if (p[0] === 1 && this.isInvertGold()) {
            return _command125.call(this, [0, p[1], p[2]]);
        }
        return _command125.call(this, p);
    };

    // Conditional Branch: Gold >= N always passes.
    const _command111 = Game_Interpreter.prototype.command111;
    Game_Interpreter.prototype.command111 = function(p) {
        if (p && p[0] === 7 && p[2] === 0 && this.isInvertGold()) {
            return _command111.call(this, [7, 0, 0]);
        }
        return _command111.call(this, p);
    };
})();
