/*******************************************************************************

    Minimal uBOL-style scriptlet framework end fixture for pruneScriptlet tests.

*/

// Important!
// Isolate from global scope

// Start of local scope
(function uBOL_scriptletFrameworkEnd($SECRET_ID$) {

/******************************************************************************/

const scriptletGlobals = self[$SECRET_ID$];
delete self[$SECRET_ID$];
scriptletGlobals.origins = undefined;
scriptletGlobals.functionRefs = undefined

/******************************************************************************/

// End of local scope
})("fixture-secret-id");

void 0;
