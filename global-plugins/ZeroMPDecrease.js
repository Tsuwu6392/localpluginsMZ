//=============================================================================
// ZeroMPDecrease.js
//=============================================================================

/*:
 * @plugindesc Neutralizes "Change MP" event commands set to Decrease by forcing their value to 0.
 * @author Claude
 *
 * @help
 * Works in both RPG Maker MV and MZ — command 312 (Change MP) and its
 * _params layout are identical in both engines.
 *
 * Intercepts event command 312 (Change MP). If the command's operation
 * parameter (this._params[2]) is 1 (Decrease), its value parameter
 * (this._params[4]) is forced to 0 before execution, effectively
 * nullifying the decrease.
 *
 * Increase MP commands (this._params[2] === 0) are left untouched.
 *
 * No plugin commands or parameters — just include it below other plugins
 * that might also touch command 312, so this runs last if you need it to
 * override their behavior too.
 */

(() => {
    const _Game_Interpreter_command312 = Game_Interpreter.prototype.command312;

    Game_Interpreter.prototype.command312 = function() {
        if (this._params[2] === 1) {
            const originalValue = this._params[4];
            this._params[4] = 0;
            const result = _Game_Interpreter_command312.call(this);
            this._params[4] = originalValue;
            return result;
        }
        return _Game_Interpreter_command312.call(this);
    };
})();
