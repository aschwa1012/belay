'use strict';
// stopwords-en.cjs — the English stopword list of the keyword half, stored verbatim.
// Source: Apache Lucene 9.12.0, org.apache.lucene.analysis.en.EnglishAnalyzer.ENGLISH_STOP_WORDS_SET (the default set of
// EnglishAnalyzer and StopAnalyzer), file lucene/analysis/common/src/java/org/apache/lucene/analysis/en/EnglishAnalyzer.java.
// Thirty-three words. Do not edit by hand: a change of list is a change of source, to be cited here.

const ENGLISH_STOP_WORDS = [
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is',
  'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'will', 'with',
];

module.exports = { ENGLISH_STOP_WORDS, SOURCE: 'Apache Lucene 9.12.0 EnglishAnalyzer.ENGLISH_STOP_WORDS_SET' };
