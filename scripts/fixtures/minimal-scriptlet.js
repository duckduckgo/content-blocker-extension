/*******************************************************************************

    Minimal uBOL-style scriptlet fixture for pruneScriptlet tests.

*/

// Start of local scope
(function uBOL_scriptlets() {

/******************************************************************************/

function keepMe() {}

function dropMe() {}

/******************************************************************************/

const scriptletGlobals = {}; // eslint-disable-line

const $hasHostnames$ = true;
const $hasEntities$ = true;
const $hasAncestors$ = true;
const $hasRegexes$ = false;

/******************************************************************************/

const todoIndices = new Set();
if ( $hasHostnames$ ) {
    const $scriptletHostnames$ = /* 3 */ ["drop.example","youtube.com","www.youtube.com"];
    void $scriptletHostnames$;
}

const todo = new Set();
if ( todoIndices.size !== 0 ) {
    const $scriptletArglistRefs$ = /* 3 */ "1;0;0,1";
    void $scriptletArglistRefs$;
}
if ( $hasRegexes$ ) {
    const $scriptletFromRegexes$ = /* 0 */ [];
    void $scriptletFromRegexes$;
}
if ( todo.size === 0 ) { return; }

{
    const $scriptletFunctions$ = /* 2 */
[keepMe,dropMe];
    const $scriptletArgs$ = /* 2 */ ["a","b"];
    const $scriptletArglists$ = /* 2 */ "0,0;1,1";
    void $scriptletFunctions$;
    void $scriptletArgs$;
    void $scriptletArglists$;
}

/******************************************************************************/

// End of local scope
})();

void 0;
