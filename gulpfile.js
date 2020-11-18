/**
 * @license
 * Copyright (c) 2017 CANDY LINE INC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const gulp        = require('gulp');
const babel       = require('gulp-babel');
const uglify      = require('gulp-uglify-es').default;
const del         = require('del');
const eslint      = require('gulp-eslint');
const jest        = require('gulp-jest').default;
const sourcemaps  = require('gulp-sourcemaps');
const gulpIf      = require('gulp-if');
const htmlmin     = require('gulp-htmlmin');
const cleancss    = require('gulp-clean-css');
const less        = require('gulp-less');
const yaml        = require('gulp-yaml');
const prettier    = require('gulp-prettier');

gulp.task('lintSrcs', () => {
  return gulp.src(['./src/**/*.js'])
  .pipe(
    eslint({
      useEslintrc: true,
      fix: true,
    })
  )
  .pipe(eslint.format())
  .pipe(prettier())
  .pipe(
    gulpIf((file) => {
      return file.eslint != null && file.eslint.fixed;
    }, gulp.dest('./src'))
  )
  .pipe(eslint.failAfterError());
});

gulp.task('lintTests', () => {
  return gulp.src(['./tests/**/*.js'])
  .pipe(
    eslint({
      useEslintrc: true,
      fix: true,
    })
  )
  .pipe(eslint.format())
  .pipe(prettier())
  .pipe(
    gulpIf((file) => {
      return file.eslint != null && file.eslint.fixed;
    }, gulp.dest('./tests'))
  )
  .pipe(eslint.failAfterError());
});

gulp.task('lint', gulp.series('lintSrcs', 'lintTests'));

gulp.task('clean', () => {
  return del([
    'dist/*',
    './dist',
    '!node_modules/**/*',
    './*.tgz',
  ]);
});

gulp.task('cleanTestJs', () => {
  return del([
    'dist/**/*.test.js',
  ]);
});

gulp.task('i18n', () => {
  return gulp.src([
      './src/locales/**/*.{yaml,yml}'
    ])
    .pipe(yaml({ safe: true }))
    .pipe(gulp.dest('./dist/locales'));
});

gulp.task('assets', gulp.series('i18n', () => {
  return gulp.src([
      './src/**/*.{less,ico,png,json,yaml,yml}',
      '!./src/locales/**/*.{yaml,yml}'
    ])
    .pipe(gulp.dest('./dist'));
}));

gulp.task('js', gulp.series('assets', () => {
  return gulp.src('./src/**/*.js')
    .pipe(sourcemaps.init())
    .pipe(
      babel({
        minified: true,
        compact: true,
        configFile: './.babelrc',
      })
    )
    .pipe(uglify({
      mangle: true,
      output: {
        comments: 'some',
      },
      compress: {
        dead_code: true,
        drop_debugger: true,
        properties: true,
        unused: true,
        toplevel: true,
        if_return: true,
        drop_console: true,
        conditionals: true,
        unsafe_math: true,
        unsafe: true
      },
    }))
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest('./dist'));
}));

gulp.task('less', () => {
  return gulp.src('./src/**/*.less')
    .pipe(sourcemaps.init())
    .pipe(less())
    .pipe(cleancss({compatibility: 'ie8'}))
    .pipe(sourcemaps.write('.'))
    .pipe(gulp.dest('./dist'));
});

gulp.task('html', () => {
  return gulp.src([
      './src/**/*.html',
      '!./src/nodes/*/node_modules/**/*.html',
    ])
    .pipe(htmlmin({
      collapseWhitespace: true,
      conservativeCollapse: true,
      minifyJS: true, minifyCSS: true,
      removeComments: true
    }))
    .pipe(gulp.dest('./dist'));
});

gulp.task('build', gulp.series('lint', 'js', 'less', 'html', 'assets'));

gulp.task('testAssets', () => {
  return gulp.src('./tests/**/*.{css,less,ico,png,html,json,yaml,yml}')
  .pipe(gulp.dest('./dist'));
});

gulp.task('test', gulp.series('build', 'testAssets', done => {
  process.env.NODE_ENV = 'test';
  return gulp.src('tests').pipe(jest({
    modulePaths: [
      '<rootDir>/src'
    ],
    preprocessorIgnorePatterns: [
      '<rootDir>/dist/',
      '<rootDir>/node_modules/'
    ],
    verbose: true,
    automock: false
  }))
  .once('error', () => { done();process.exit(1); })
  .once('end', () => { done();process.exit(); })
}));

gulp.task('default', gulp.series('build'));
