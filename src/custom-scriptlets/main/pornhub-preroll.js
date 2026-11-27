/*******************************************************************************
    Copyright (C) 2026 Duck Duck Go, Inc.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.
*/

// The mobile player reads its pre-roll from first-party config (flashvars_<id>.adRollGlobalConfig),
// which no network rule or upstream uBO scriptlet covers. Empty it before the player starts.
(() => {
    if (!/(^|\.)pornhub\.com$/.test(location.hostname)) {
        return;
    }
    const clearAdRolls = () => {
        for (const key of Object.keys(window)) {
            const flashvars = key.startsWith('flashvars_') ? window[key] : null;
            if (flashvars && Array.isArray(flashvars.adRollGlobalConfig) && flashvars.adRollGlobalConfig.length) {
                flashvars.adRollGlobalConfig = [];
            }
        }
    };
    new MutationObserver(clearAdRolls).observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', clearAdRolls);
})();
