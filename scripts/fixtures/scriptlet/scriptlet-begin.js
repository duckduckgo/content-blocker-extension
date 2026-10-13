/*******************************************************************************

    Minimal uBOL-style scriptlet framework begin fixture for pruneScriptlet tests.

*/

// Important!
// Isolate from global scope

// Start of local scope
(function uBOL_scriptletFrameworkBegin($SECRET_ID$) {

/******************************************************************************/

const scriptletGlobals = self[$SECRET_ID$] = {};

if ( typeof $SCRIPTLET_GLOBALS$ !== 'undefined' && self.$SCRIPTLET_GLOBALS$ === undefined ) {
    Object.assign(scriptletGlobals, $SCRIPTLET_GLOBALS$); // eslint-disable-line
}

/******************************************************************************/

class Recorder {
    static record(...args) {
        self.calls.push(args);
    }
}

class Unused {}

function helperFn(name, arg) {
    Recorder.record(name, arg);
}

function dropHelper(arg) {
    self.calls.push(['dropped', arg]);
}

function keepMe(arg) {
    helperFn('keepMe', arg);
}

function keepToo(arg) {
    helperFn('keepToo', arg);
}

function dropMe(arg) {
    dropHelper(arg);
}

/******************************************************************************/

scriptletGlobals.origins = (( ) => {
    const docloc = document.location;
    const origins = [ docloc.origin ];
    if ( docloc.ancestorOrigins ) {
        origins.push(...docloc.ancestorOrigins);
    }
    const out = [];
    for ( let i = 0; i < origins.length; i++ ) {
        const origin = origins[i];
        const beg = origin.indexOf('://') + 3;
        if ( beg === 2 ) { continue; }
        const end = origin.indexOf(':', beg);
        const hn = origin.slice(beg, end > 0 ? end : undefined);
        if ( hn.length === 0 ) { continue; }
        const hns = [ hn ];
        for ( let pos = 0; ; ) {
            pos = hn.indexOf('.', pos) + 1;
            if ( pos === 0 ) { break; }
            hns.push(hn.slice(pos));
        }
        hns.push('*');
        const ens = [];
        for ( let hn of hns ) {
            for (;;) {
                const pos = hn.lastIndexOf('.');
                if ( pos === -1 ) { break; }
                hn = hn.slice(0, pos);
                ens.push(`${hn}.*`);
            }
        }
        ens.sort((a, b) => {
            const d = b.length - a.length;
            if ( d !== 0 ) { return d; }
            return a > b ? -1 : 1;
        });
        out.push({ hns, ens, i });
    }
    return out;
})();

scriptletGlobals.functionRefs = /* 3 */ [keepMe,keepToo,dropMe];

/******************************************************************************/

// End of local scope
})("fixture-secret-id");

void 0;
