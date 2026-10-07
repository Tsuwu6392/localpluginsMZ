//=============================================================================
// InvertedShopping.js
//=============================================================================
/*:
 * @target MV MZ
 * @plugindesc Buying an item gives you gold equal to its price instead of costing it.
 * @author You
 *
 * @param switchId
 * @text Toggle Switch ID
 * @type switch
 * @desc Inversion is only active while this switch is ON. 0 = always active.
 * @default 0
 *
 * @help
 * While active, buying in a shop ADDS the price to your gold instead of
 * subtracting it. You can't run out of gold to buy, so the only limit on
 * quantity is the item cap (e.g. 99). Selling is unchanged.
 *
 * No plugin commands. Name this file InvertedShopping.js.
 */

(() => {
    "use strict";

    const params = PluginManager.parameters("InvertedShopping");
    const switchId = Number(params.switchId || 0);
    const isActive = () => switchId === 0 || $gameSwitches.value(switchId);

    // Purchase: gain gold instead of losing it.
    const _doBuy = Scene_Shop.prototype.doBuy;
    Scene_Shop.prototype.doBuy = function(number) {
        if (!isActive()) return _doBuy.call(this, number);
        $gameParty.gainGold(number * this.buyingPrice());
        $gameParty.gainItem(this._item, number);
    };

    // Max quantity: no longer limited by how much gold you have.
    const _maxBuy = Scene_Shop.prototype.maxBuy;
    Scene_Shop.prototype.maxBuy = function() {
        if (!isActive()) return _maxBuy.call(this);
        return $gameParty.maxItems(this._item) - $gameParty.numItems(this._item);
    };

    // Buy list: items are selectable even if you're broke.
    const _isEnabled = Window_ShopBuy.prototype.isEnabled;
    Window_ShopBuy.prototype.isEnabled = function(item) {
        if (!isActive()) return _isEnabled.call(this, item);
        return !!item && !$gameParty.hasMaxItems(item);
    };
})();