// simple repeat helper module
module.exports = (function () {
    let repeatMode = 'no_repeat'; // 'no_repeat' | 'repeat_one' | 'repeat_all'

    return {
        get: () => repeatMode,
        set: (mode) => {
            if (['no_repeat', 'repeat_one', 'repeat_all'].includes(mode)) {
                repeatMode = mode;
            }
            return repeatMode;
        },
        toggle: () => {
            if (repeatMode === 'no_repeat') repeatMode = 'repeat_all';
            else if (repeatMode === 'repeat_all') repeatMode = 'repeat_one';
            else repeatMode = 'no_repeat';
            return repeatMode;
        }
    };
})();