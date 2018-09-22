
'use strict';

var async = require('async');
var _ = require('lodash');

var db = require('../database');
var user = require('../user');
var posts = require('../posts');
var notifications = require('../notifications');
var categories = require('../categories');
var privileges = require('../privileges');
var meta = require('../meta');
var utils = require('../utils');
var plugins = require('../plugins');

module.exports = function (Topics) {
	Topics.getTotalUnread = function (uid, filter, callback) {
		if (!callback) {
			callback = filter;
			filter = '';
		}
		Topics.getUnreadTids({ cid: 0, uid: uid, filter: filter }, function (err, tids) {
			callback(err, Array.isArray(tids) ? tids.length : 0);
		});
	};

	Topics.getUnreadTopics = function (params, callback) {
		var unreadTopics = {
			showSelect: true,
			nextStart: 0,
			topics: [],
		};

		async.waterfall([
			function (next) {
				Topics.getUnreadTids(params, next);
			},
			function (tids, next) {
				unreadTopics.topicCount = tids.length;

				if (!tids.length) {
					return next(null, []);
				}

				tids = tids.slice(params.start, params.stop !== -1 ? params.stop + 1 : undefined);

				Topics.getTopicsByTids(tids, params.uid, next);
			},
			function (topicData, next) {
				if (!topicData.length) {
					return next(null, unreadTopics);
				}

				unreadTopics.topics = topicData;
				unreadTopics.nextStart = params.stop + 1;
				next(null, unreadTopics);
			},
		], callback);
	};

	Topics.unreadCutoff = function () {
		var cutoff = parseInt(meta.config.unreadCutoff, 10) || 2;
		return Date.now() - (cutoff * 86400000);
	};

	Topics.getUnreadCounts = function (uid, callback) {
		// get unread counts for each filter
		var uid = parseInt(uid, 10);
		if (uid <= 0) {
			return callback(null, {
				'': 0,
				new: 0,
				watched: 0,
				unreplied: 0,
			});
		}

		var cutoff = Topics.unreadCutoff();

		async.waterfall([
			function (next) {
				async.parallel({
					ignoredTids: function (next) {
						user.getIgnoredTids(uid, 0, -1, next);
					},
					recentTids: function (next) {
						db.getSortedSetRevRangeByScoreWithScores('topics:recent', 0, -1, '+inf', cutoff, next);
					},
					userScores: function (next) {
						db.getSortedSetRevRangeByScoreWithScores('uid:' + uid + ':tids_read', 0, -1, '+inf', cutoff, next);
					},
					tids_unread: function (next) {
						db.getSortedSetRevRangeWithScores('uid:' + uid + ':tids_unread', 0, -1, next);
					},
				}, next);
			},
			function (results, next) {
				if (results.recentTids && !results.recentTids.length && !results.tids_unread.length) {
					return callback(null, []);
				}

				countTopics({
					cid: 0,
					uid: uid,
				}, results, next);
			},
			function (counts, next) {
				plugins.fireHook('filter:topics.getUnreadCounts', {
					uid: uid,
					counts: counts,
				}, next);
			},
			function (results, next) {
				next(null, results.counts);
			},
		], callback);
	};

	function countTopics(params, results, callback) {
		var counts = {
			'': 0,
			new: 0,
			watched: 0,
			unreplied: 0,
		};

		var userRead = {};
		results.userScores.forEach(function (userItem) {
			userRead[userItem.value] = userItem.score;
		});

		results.recentTids = results.recentTids.concat(results.tids_unread);
		results.recentTids.sort(function (a, b) {
			return b.score - a.score;
		});


		var tids = results.recentTids.filter(function (recentTopic) {
			if (results.ignoredTids.includes(String(recentTopic.value))) {
				return false;
			}
			return !userRead[recentTopic.value] || recentTopic.score > userRead[recentTopic.value];
		});

		// convert topics to tids
		tids = tids.map(function (topic) {
			return topic.value;
		});

		// make sure tids are unique
		tids = _.uniq(tids);

		var cid = params.cid;
		var uid = params.uid;
		var cids;
		var topicData;

		tids = tids.slice(0, 200);

		if (!tids.length) {
			return callback(null, counts);
		}

		async.waterfall([
			function (next) {
				Topics.getTopicsFields(tids, ['tid', 'cid', 'postcount'], next);
			},
			function (topicData, next) {
				user.blocks.filter(uid, topicData, next);
			},
			function (_topicData, next) {
				topicData = _topicData;
				tids = topicData.map(topic => topic.tid);
				cids = _.uniq(topicData.map(topic => topic.cid)).filter(Boolean);

				async.parallel({
					isTopicsFollowed: function (next) {
						db.sortedSetScores('uid:' + uid + ':followed_tids', tids, next);
					},
					ignoredCids: function (next) {
						user.getIgnoredCategories(uid, next);
					},
					readableCids: function (next) {
						privileges.categories.filterCids('read', cids, uid, next);
					},
				}, next);
			},
			function (results, next) {
				cid = cid && cid.map(String);

				topicData.forEach(function (topic, index) {
					function cidMatch(topicCid) {
						return (!cid || (cid.length && cid.includes(String(topicCid))))
					}
					// all, watched, new, unreplied
					if (topic && topic.cid && cidMatch(topic.cid)) {
						if ((results.isTopicsFollowed[index] || !results.ignoredCids.includes(String(topic.cid)))) {
							counts[''] ++;
						}

						if (results.isTopicsFollowed[index]) {
							counts.watched ++;
						}

						if (parseInt(topic.postcount, 10) === 1) {
							console.log(topic.tid);
							counts.unreplied ++;
						}

						if (!userRead[topic.tid]) {
							counts.new ++;
						}
					}
				})
				// topicData = topicData.filter(function (topic, index) {
				// 	return topic && topic.cid &&
				// 		(!!results.isTopicsFollowed[index] || !results.ignoredCids.includes(String(topic.cid))) &&
				// 		(!cid || (cid.length && cid.includes(String(topic.cid))));
				// });

				next(null, []);
			},
			function (filteredTopics, next) {
				// tids = filteredTopics.map(function (topic) {
				// 	return topic && topic.tid;
				// });
				// filterTidsThatHaveBlockedPosts(uid, tids, next);
				next(null, tids);
			},
			function (tids, next) {
				next(null, counts);
			}
		], callback);
	}

	Topics.getUnreadTids = function (params, callback) {
		var uid = parseInt(params.uid, 10);
		if (uid <= 0) {
			return callback(null, []);
		}

		var cutoff = params.cutoff || Topics.unreadCutoff();

		if (params.cid && !Array.isArray(params.cid)) {
			params.cid = [params.cid];
		}

		async.waterfall([
			function (next) {
				async.parallel({
					ignoredTids: function (next) {
						user.getIgnoredTids(uid, 0, -1, next);
					},
					recentTids: function (next) {
						db.getSortedSetRevRangeByScoreWithScores('topics:recent', 0, -1, '+inf', cutoff, next);
					},
					userScores: function (next) {
						db.getSortedSetRevRangeByScoreWithScores('uid:' + uid + ':tids_read', 0, -1, '+inf', cutoff, next);
					},
					tids_unread: function (next) {
						db.getSortedSetRevRangeWithScores('uid:' + uid + ':tids_unread', 0, -1, next);
					},
				}, next);
			},
			function (results, next) {
				if (results.recentTids && !results.recentTids.length && !results.tids_unread.length) {
					return callback(null, []);
				}

				filterTopics(params, results, next);
			},
			function (tids, next) {
				plugins.fireHook('filter:topics.getUnreadTids', {
					uid: uid,
					tids: tids,
					cid: params.cid,
					filter: params.filter,
				}, next);
			},
			function (results, next) {
				next(null, results.tids);
			},
		], callback);
	};

	function filterTopics(params, results, callback) {
		var userRead = {};
		results.userScores.forEach(function (userItem) {
			userRead[userItem.value] = userItem.score;
		});

		results.recentTids = results.recentTids.concat(results.tids_unread);
		results.recentTids.sort(function (a, b) {
			return b.score - a.score;
		});


		var tids = results.recentTids.filter(function (recentTopic) {
			if (results.ignoredTids.includes(String(recentTopic.value))) {
				return false;
			}
			switch (params.filter) {
			case 'new':
				return !userRead[recentTopic.value];
			default:
				return !userRead[recentTopic.value] || recentTopic.score > userRead[recentTopic.value];
			}
		});

		// convert topics to tids
		tids = tids.map(function (topic) {
			return topic.value;
		});

		// make sure tids are unique
		tids = _.uniq(tids);

		var cid = params.cid;
		var uid = params.uid;

		async.waterfall([
			function (next) {
				if (params.filter === 'watched') {
					Topics.filterWatchedTids(tids, uid, next);
				} else if (params.filter === 'unreplied') {
					Topics.filterUnrepliedTids(tids, next);
				} else {
					next(null, tids);
				}
			},
			function (tids, next) {
				tids = tids.slice(0, 200);
				if (!tids.length) {
					return callback(null, tids);
				}
				privileges.topics.filterTids('read', tids, uid, next);
			},
			function (tids, next) {
				async.parallel({
					topics: function (next) {
						Topics.getTopicsFields(tids, ['tid', 'uid', 'cid'], next);
					},
					isTopicsFollowed: function (next) {
						if (params.filter === 'watched' || params.filter === 'new') {
							return next(null, []);
						}
						db.sortedSetScores('uid:' + uid + ':followed_tids', tids, next);
					},
					ignoredCids: function (next) {
						if (params.filter === 'watched') {
							return next(null, []);
						}
						user.getIgnoredCategories(uid, next);
					},
				}, next);
			},
			function (results, next) {
				var topics = results.topics;

				cid = cid && cid.map(String);
				topics = topics.filter(function (topic, index) {
					return topic && topic.cid &&
						(!!results.isTopicsFollowed[index] || !results.ignoredCids.includes(String(topic.cid))) &&
						(!cid || (cid.length && cid.includes(String(topic.cid))));
				});

				user.blocks.filter(uid, topics, next);
			},
			function (filteredTopics, next) {
				tids = filteredTopics.map(function (topic) {
					return topic && topic.tid;
				});
				filterTidsThatHaveBlockedPosts(uid, tids, next);
			},
		], callback);
	}

	function filterTidsThatHaveBlockedPosts(uid, tids, callback) {
		return callback(null, tids);
		async.filter(tids, function (tid, next) {
			doesTidHaveUnblockedUnreadPosts(uid, tid, next);
		}, callback);
	}

	function doesTidHaveUnblockedUnreadPosts(uid, tid, callback) {
		var topicTimestamp;
		var userLastReadTimestamp;
		async.waterfall([
			function (next) {
				async.parallel({
					topicTimestamp: async.apply(db.sortedSetScore, 'topics:recent', tid),
					userLastReadTimestamp: async.apply(db.sortedSetScore, 'uid:' + uid + ':tids_read', tid),
				}, next);
			},
			function (results, next) {
				topicTimestamp = results.topicTimestamp;
				userLastReadTimestamp = results.userLastReadTimestamp;
				if (!userLastReadTimestamp) {
					return callback(null, true);
				}
				db.getSortedSetRevRangeByScore('tid:' + tid + ':posts', 0, -1, '+inf', userLastReadTimestamp, next);
			},
			function (pidsSinceLastVisit, next) {
				if (!pidsSinceLastVisit.length) {
					return callback(null, topicTimestamp > userLastReadTimestamp);
				}
				posts.getPostsFields(pidsSinceLastVisit, ['pid', 'uid'], next);
			},
			function (postData, next) {
				user.blocks.filter(uid, postData, next);
			},
			function (unreadPosts, next) {
				next(null, unreadPosts.length > 0);
			},
		], callback);
	}

	Topics.pushUnreadCount = function (uid, callback) {
		callback = callback || function () {};

		if (!uid || parseInt(uid, 10) === 0) {
			return setImmediate(callback);
		}

		async.waterfall([
			function (next) {
				async.parallel({
					unreadTopicCount: async.apply(Topics.getTotalUnread, uid),
					unreadNewTopicCount: async.apply(Topics.getTotalUnread, uid, 'new'),
					unreadWatchedTopicCount: async.apply(Topics.getTotalUnread, uid, 'watched'),
				}, next);
			},
			function (results, next) {
				require('../socket.io').in('uid_' + uid).emit('event:unread.updateCount', results);
				setImmediate(next);
			},
		], callback);
	};

	Topics.markAsUnreadForAll = function (tid, callback) {
		Topics.markCategoryUnreadForAll(tid, callback);
	};

	Topics.markAsRead = function (tids, uid, callback) {
		callback = callback || function () {};
		if (!Array.isArray(tids) || !tids.length) {
			return setImmediate(callback, null, false);
		}

		tids = _.uniq(tids).filter(function (tid) {
			return tid && utils.isNumber(tid);
		});

		if (!tids.length) {
			return setImmediate(callback, null, false);
		}

		async.waterfall([
			function (next) {
				async.parallel({
					topicScores: async.apply(db.sortedSetScores, 'topics:recent', tids),
					userScores: async.apply(db.sortedSetScores, 'uid:' + uid + ':tids_read', tids),
				}, next);
			},
			function (results, next) {
				tids = tids.filter(function (tid, index) {
					return results.topicScores[index] && (!results.userScores[index] || results.userScores[index] < results.topicScores[index]);
				});

				if (!tids.length) {
					return callback(null, false);
				}

				var now = Date.now();
				var scores = tids.map(function () {
					return now;
				});

				async.parallel({
					markRead: async.apply(db.sortedSetAdd, 'uid:' + uid + ':tids_read', scores, tids),
					markUnread: async.apply(db.sortedSetRemove, 'uid:' + uid + ':tids_unread', tids),
					topicData: async.apply(Topics.getTopicsFields, tids, ['cid']),
				}, next);
			},
			function (results, next) {
				var cids = results.topicData.map(function (topic) {
					return topic && topic.cid;
				}).filter(Boolean);

				cids = _.uniq(cids);

				categories.markAsRead(cids, uid, next);
			},
			function (next) {
				plugins.fireHook('action:topics.markAsRead', { uid: uid, tids: tids });
				next(null, true);
			},
		], callback);
	};

	Topics.markAllRead = function (uid, callback) {
		async.waterfall([
			function (next) {
				db.getSortedSetRevRangeByScore('topics:recent', 0, -1, '+inf', Topics.unreadCutoff(), next);
			},
			function (tids, next) {
				Topics.markTopicNotificationsRead(tids, uid);
				Topics.markAsRead(tids, uid, next);
			},
			function (markedRead, next) {
				db.delete('uid:' + uid + ':tids_unread', next);
			},
		], callback);
	};

	Topics.markTopicNotificationsRead = function (tids, uid, callback) {
		callback = callback || function () {};
		if (!Array.isArray(tids) || !tids.length) {
			return callback();
		}

		async.waterfall([
			function (next) {
				user.notifications.getUnreadByField(uid, 'tid', tids, next);
			},
			function (nids, next) {
				notifications.markReadMultiple(nids, uid, next);
			},
			function (next) {
				user.notifications.pushCount(uid);
				next();
			},
		], callback);
	};

	Topics.markCategoryUnreadForAll = function (tid, callback) {
		async.waterfall([
			function (next) {
				Topics.getTopicField(tid, 'cid', next);
			},
			function (cid, next) {
				categories.markAsUnreadForAll(cid, next);
			},
		], callback);
	};

	Topics.hasReadTopics = function (tids, uid, callback) {
		if (!parseInt(uid, 10)) {
			return callback(null, tids.map(function () {
				return false;
			}));
		}

		async.waterfall([
			function (next) {
				async.parallel({
					recentScores: function (next) {
						db.sortedSetScores('topics:recent', tids, next);
					},
					userScores: function (next) {
						db.sortedSetScores('uid:' + uid + ':tids_read', tids, next);
					},
					tids_unread: function (next) {
						db.sortedSetScores('uid:' + uid + ':tids_unread', tids, next);
					},
				}, next);
			},
			function (results, next) {
				var cutoff = Topics.unreadCutoff();
				var result = tids.map(function (tid, index) {
					var read = !results.tids_unread[index] &&
						(results.recentScores[index] < cutoff ||
						!!(results.userScores[index] && results.userScores[index] >= results.recentScores[index]));
					return { tid: tid, read: read };
				});

				async.map(result, function (data, next) {
					if (data.read) {
						return next(null, true);
					}
					doesTidHaveUnblockedUnreadPosts(uid, data.tid, function (err, hasUnblockedUnread) {
						if (err) {
							return next(err);
						}
						if (!hasUnblockedUnread) {
							data.read = true;
						}
						next(null, data.read);
					});
				}, next);
			},
		], callback);
	};

	Topics.hasReadTopic = function (tid, uid, callback) {
		Topics.hasReadTopics([tid], uid, function (err, hasRead) {
			callback(err, Array.isArray(hasRead) && hasRead.length ? hasRead[0] : false);
		});
	};

	Topics.markUnread = function (tid, uid, callback) {
		async.waterfall([
			function (next) {
				Topics.exists(tid, next);
			},
			function (exists, next) {
				if (!exists) {
					return next(new Error('[[error:no-topic]]'));
				}
				db.sortedSetRemove('uid:' + uid + ':tids_read', tid, next);
			},
			function (next) {
				db.sortedSetAdd('uid:' + uid + ':tids_unread', Date.now(), tid, next);
			},
		], callback);
	};

	Topics.filterNewTids = function (tids, uid, callback) {
		async.waterfall([
			function (next) {
				db.sortedSetScores('uid:' + uid + ':tids_read', tids, next);
			},
			function (scores, next) {
				tids = tids.filter(function (tid, index) {
					return tid && !scores[index];
				});
				next(null, tids);
			},
		], callback);
	};

	Topics.filterUnrepliedTids = function (tids, callback) {
		async.waterfall([
			function (next) {
				db.sortedSetScores('topics:posts', tids, next);
			},
			function (scores, next) {
				tids = tids.filter(function (tid, index) {
					return tid && scores[index] <= 1;
				});
				next(null, tids);
			},
		], callback);
	};
};
