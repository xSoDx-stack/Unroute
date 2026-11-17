'use strict';

const gulp = require('gulp');
const del = require('del');

const clean = function(cb) {
  del.sync('./dist');
  return cb();
};

const cleanChrome = function(cb) {
  del.sync('./dist/chromium');
  return cb();
};

const cleanFirefox = function(cb) {
  del.sync('./dist/firefox');
  return cb();
};

const commonSrc = ['./src/common/**/*'];
const chromiumDst = './dist/chromium';
const firefoxDst = './dist/firefox';

const copyChromeNotices = () => gulp.src(['./LICENSE', './PRIVACY.md'], { encoding: false })
  .pipe(gulp.dest(chromiumDst));
const copyFirefoxNotices = () => gulp.src(['./LICENSE', './PRIVACY.md'], { encoding: false })
  .pipe(gulp.dest(firefoxDst));

const copyChromium = function() {
  return gulp.src(commonSrc, { encoding: false })
    .pipe(gulp.dest(chromiumDst));
};

const firefoxCommonSrc = [
  ...commonSrc,
  '!./src/common/manifest.json',
];

const copyFirefoxCommon = function() {
  return gulp.src(firefoxCommonSrc, { encoding: false })
    .pipe(gulp.dest(firefoxDst));
};

const copyFirefoxOverrides = function() {
  return gulp.src('./src/firefox/**/*', { encoding: false })
    .pipe(gulp.dest(firefoxDst));
};

const copyFirefox = gulp.series(copyFirefoxCommon, copyFirefoxOverrides);
const buildChrome = gulp.series(cleanChrome, copyChromium, copyChromeNotices);
const buildFirefox = gulp.series(cleanFirefox, copyFirefox, copyFirefoxNotices);
const buildTargets = gulp.series(clean, gulp.parallel(
  gulp.series(copyChromium, copyChromeNotices),
  gulp.series(copyFirefox, copyFirefoxNotices)
));

module.exports = {
  default: buildTargets,
  buildChrome,
  buildFirefox,
  buildTargets,
};

