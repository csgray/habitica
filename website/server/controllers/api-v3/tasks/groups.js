import { authWithHeaders } from '../../../middlewares/auth';
import * as Tasks from '../../../models/task';
import { model as Group } from '../../../models/group';
import { model as User } from '../../../models/user';
import {
  BadRequest,
  NotFound,
  NotAuthorized,
} from '../../../libs/errors';
import {
  createTasks,
  getTasks,
  moveTask,
} from '../../../libs/taskManager';

let requiredGroupFields = '_id leader tasksOrder name';
let types = Tasks.tasksTypes.map(type => `${type}s`);

function canNotEditTasks (group, user, assignedUserId) {
  let isNotGroupLeader = group.leader !== user._id;
  let isManager = Boolean(group.managers[user._id]);
  let userIsAssigningToSelf = Boolean(assignedUserId && user._id === assignedUserId);
  return isNotGroupLeader && !isManager && !userIsAssigningToSelf;
}

let api = {};

/**
 * @api {post} /api/v3/tasks/group/:groupId Create a new task belonging to a group
 * @apiDescription Can be passed an object to create a single task or an array of objects to create multiple tasks.
 * @apiName CreateGroupTasks
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} groupId The id of the group the new task(s) will belong to
 *
 * @apiSuccess data An object if a single task was created, otherwise an array of tasks
 */
api.createGroupTasks = {
  method: 'POST',
  url: '/tasks/group/:groupId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('groupId', res.t('groupIdRequired')).notEmpty().isUUID();

    let reqValidationErrors = req.validationErrors();
    if (reqValidationErrors) throw reqValidationErrors;

    let user = res.locals.user;

    let fields = requiredGroupFields.concat(' managers');
    let group = await Group.getGroup({user, groupId: req.params.groupId, fields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (canNotEditTasks(group, user)) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));

    let tasks = await createTasks(req, res, {user, group});

    res.respond(201, tasks.length === 1 ? tasks[0] : tasks);

    tasks.forEach((task) => {
      res.analytics.track('task create', {
        uuid: user._id,
        hitType: 'event',
        category: 'behavior',
        taskType: task.type,
        groupID: group._id,
      });
    });
  },
};

/**
 * @api {get} /api/v3/tasks/group/:groupId Get a group's tasks
 * @apiName GetGroupTasks
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} groupId The id of the group from which to retrieve the tasks
 * @apiParam (Query) {string="habits","dailys","todos","rewards"} [type] Query parameter to return just a type of tasks
 *
 * @apiSuccess {Array} data An array of tasks
 */
api.getGroupTasks = {
  method: 'GET',
  url: '/tasks/group/:groupId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('groupId', res.t('groupIdRequired')).notEmpty().isUUID();
    req.checkQuery('type', res.t('invalidTasksType')).optional().isIn(types);

    let validationErrors = req.validationErrors();
    if (validationErrors) throw validationErrors;

    let user = res.locals.user;

    let group = await Group.getGroup({user, groupId: req.params.groupId, fields: requiredGroupFields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    let tasks = await getTasks(req, res, {user, group});
    res.respond(200, tasks);
  },
};

/**
 * @api {post} /api/v3/group/:groupId/tasks/:taskId/move/to/:position Move a group task to a specified position
 * @apiDescription Moves a group task to a specified position
 * @apiVersion 3.0.0
 * @apiName GroupMoveTask
 * @apiGroup Task
 *
 * @apiParam (Path) {String} taskId The task _id
 * @apiParam (Path) {Number} position Where to move the task (-1 means push to bottom). First position is 0
 *
 * @apiSuccess {Array} data The new tasks order (group.tasksOrder.{task.type}s)
 */
api.groupMoveTask = {
  method: 'POST',
  url: '/group-tasks/:taskId/move/to/:position',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('taskId', res.t('taskIdRequired')).notEmpty();
    req.checkParams('position', res.t('positionRequired')).notEmpty().isNumeric();

    let reqValidationErrors = req.validationErrors();
    if (reqValidationErrors) throw reqValidationErrors;

    let user = res.locals.user;

    let taskId = req.params.taskId;
    let task = await Tasks.Task.findOne({
      _id: taskId,
    }).exec();

    let to = Number(req.params.position);

    if (!task) {
      throw new NotFound(res.t('taskNotFound'));
    }

    if (task.type === 'todo' && task.completed) throw new BadRequest(res.t('cantMoveCompletedTodo'));

    let group = await Group.getGroup({user, groupId: task.group.id, fields: requiredGroupFields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (group.leader !== user._id) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));

    let order = group.tasksOrder[`${task.type}s`];

    moveTask(order, task._id, to);

    await group.save();
    res.respond(200, order);
  },
};

/**
 * @api {post} /api/v3/tasks/:taskId/assign/:assignedUserId Assign a group task to a user
 * @apiDescription Assigns a user to a group task
 * @apiName AssignTask
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} taskId The id of the task that will be assigned
 * @apiParam (Path) {UUID} assignedUserId The id of the user that will be assigned to the task
 *
 * @apiSuccess data An object if a single task was created, otherwise an array of tasks
 */
api.assignTask = {
  method: 'POST',
  url: '/tasks/:taskId/assign/:assignedUserId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('taskId', res.t('taskIdRequired')).notEmpty().isUUID();
    req.checkParams('assignedUserId', res.t('userIdRequired')).notEmpty().isUUID();

    let reqValidationErrors = req.validationErrors();
    if (reqValidationErrors) throw reqValidationErrors;

    let user = res.locals.user;
    let assignedUserId = req.params.assignedUserId;
    let assignedUser = await User.findById(assignedUserId).exec();

    let taskId = req.params.taskId;
    let task = await Tasks.Task.findByIdOrAlias(taskId, user._id);

    if (!task) {
      throw new NotFound(res.t('taskNotFound'));
    }

    if (!task.group.id) {
      throw new NotAuthorized(res.t('onlyGroupTasksCanBeAssigned'));
    }

    let groupFields = `${requiredGroupFields} chat managers`;
    let group = await Group.getGroup({user, groupId: task.group.id, fields: groupFields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (canNotEditTasks(group, user, assignedUserId)) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));

    let promises = [];

    // User is claiming the task
    if (user._id === assignedUserId) {
      let message = res.t('userIsClamingTask', {username: user.profile.name, task: task.text});
      const newMessage = group.sendChat(message);
      promises.push(newMessage.save());
    }

    promises.push(group.syncTask(task, assignedUser));
    promises.push(group.save());
    await Promise.all(promises);

    res.respond(200, task);
  },
};

/**
 * @api {post} /api/v3/tasks/:taskId/unassign/:assignedUserId Unassign a user from a task
 * @apiDescription Unassigns a user to from a group task
 * @apiName UnassignTask
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} taskId The id of the task that will be assigned
 * @apiParam (Path) {UUID} assignedUserId The id of the user that will be unassigned from the task
 *
 * @apiSuccess data An object if a single task was created, otherwise an array of tasks
 */
api.unassignTask = {
  method: 'POST',
  url: '/tasks/:taskId/unassign/:assignedUserId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('taskId', res.t('taskIdRequired')).notEmpty().isUUID();
    req.checkParams('assignedUserId', res.t('userIdRequired')).notEmpty().isUUID();

    let reqValidationErrors = req.validationErrors();
    if (reqValidationErrors) throw reqValidationErrors;

    let user = res.locals.user;
    let assignedUserId = req.params.assignedUserId;
    let assignedUser = await User.findById(assignedUserId).exec();

    let taskId = req.params.taskId;
    let task = await Tasks.Task.findByIdOrAlias(taskId, user._id);

    if (!task) {
      throw new NotFound(res.t('taskNotFound'));
    }

    if (!task.group.id) {
      throw new NotAuthorized(res.t('onlyGroupTasksCanBeAssigned'));
    }

    let fields = requiredGroupFields.concat(' managers');
    let group = await Group.getGroup({user, groupId: task.group.id, fields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (canNotEditTasks(group, user, assignedUserId)) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));

    await group.unlinkTask(task, assignedUser);

    res.respond(200, task);
  },
};

/**
 * @api {post} /api/v3/tasks/:taskId/approve/:userId Approve a user's task
 * @apiDescription Approves a user assigned to a group task
 * @apiVersion 3.0.0
 * @apiName ApproveTask
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} taskId The id of the task that is the original group task
 * @apiParam (Path) {UUID} userId The id of the user that will be approved
 *
 * @apiSuccess task The approved task
 */
api.approveTask = {
  method: 'POST',
  url: '/tasks/:taskId/approve/:userId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('taskId', res.t('taskIdRequired')).notEmpty().isUUID();
    req.checkParams('userId', res.t('userIdRequired')).notEmpty().isUUID();

    let reqValidationErrors = req.validationErrors();
    if (reqValidationErrors) throw reqValidationErrors;

    let user = res.locals.user;
    let assignedUserId = req.params.userId;
    let assignedUser = await User.findById(assignedUserId).exec();

    let taskId = req.params.taskId;
    let task = await Tasks.Task.findOne({
      'group.taskId': taskId,
      userId: assignedUserId,
    }).exec();

    if (!task) {
      throw new NotFound(res.t('taskNotFound'));
    }

    let fields = requiredGroupFields.concat(' managers');
    let group = await Group.getGroup({user, groupId: task.group.id, fields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (canNotEditTasks(group, user)) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));
    if (task.group.approval.approved === true) throw new NotAuthorized(res.t('canOnlyApproveTaskOnce'));

    task.group.approval.dateApproved = new Date();
    task.group.approval.approvingUser = user._id;
    task.group.approval.approved = true;

    // Get Managers
    const managerIds = Object.keys(group.managers);
    managerIds.push(group.leader);
    const managers = await User.find({_id: managerIds}, 'notifications').exec(); // Use this method so we can get access to notifications

    // Get task direction
    const firstManagerNotifications = managers[0].notifications;
    const firstNotificationIndex = firstManagerNotifications.findIndex((notification) => {
      return notification && notification.data && notification.data.taskId === task._id && notification.type === 'GROUP_TASK_APPROVAL';
    });
    let direction = 'up';
    if (firstManagerNotifications[firstNotificationIndex]) {
      direction = firstManagerNotifications[firstNotificationIndex].direction;
    }

    // Remove old notifications
    let managerPromises = [];
    managers.forEach((manager) => {
      let notificationIndex = manager.notifications.findIndex(function findNotification (notification) {
        return notification && notification.data && notification.data.taskId === task._id && notification.type === 'GROUP_TASK_APPROVAL';
      });

      if (notificationIndex !== -1) {
        manager.notifications.splice(notificationIndex, 1);
        managerPromises.push(manager.save());
      }
    });

    // Add new notifications to user
    assignedUser.addNotification('GROUP_TASK_APPROVED', {
      message: res.t('yourTaskHasBeenApproved', {taskText: task.text}),
      groupId: group._id,
    });

    assignedUser.addNotification('SCORED_TASK', {
      message: res.t('yourTaskHasBeenApproved', {taskText: task.text}),
      scoreTask: task,
      direction,
    });

    managerPromises.push(task.save());
    managerPromises.push(assignedUser.save());
    await Promise.all(managerPromises);

    res.respond(200, task);
  },
};

/**
 * @api {post} /api/v3/tasks/:taskId/needs-work/:userId Group task needs more work
 * @apiDescription Mark an assigned group task as needeing more work before it can be approved
 * @apiVersion 3.0.0
 * @apiName TaskNeedsWork
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} taskId The id of the task that is the original group task
 * @apiParam (Path) {UUID} userId The id of the assigned user
 *
 * @apiSuccess task The task that needs more work
 */
api.taskNeedsWork = {
  method: 'POST',
  url: '/tasks/:taskId/needs-work/:userId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('taskId', res.t('taskIdRequired')).notEmpty().isUUID();
    req.checkParams('userId', res.t('userIdRequired')).notEmpty().isUUID();

    let reqValidationErrors = req.validationErrors();
    if (reqValidationErrors) throw reqValidationErrors;

    let user = res.locals.user;

    let assignedUserId = req.params.userId;
    let taskId = req.params.taskId;

    const [assignedUser, task] = await Promise.all([
      User.findById(assignedUserId).exec(),
      await Tasks.Task.findOne({
        'group.taskId': taskId,
        userId: assignedUserId,
      }).exec(),
    ]);

    if (!task) {
      throw new NotFound(res.t('taskNotFound'));
    }

    let fields = requiredGroupFields.concat(' managers');
    let group = await Group.getGroup({user, groupId: task.group.id, fields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (canNotEditTasks(group, user)) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));
    if (task.group.approval.approved === true) throw new NotAuthorized(res.t('canOnlyApproveTaskOnce'));
    if (!task.group.approval.requested) {
      throw new NotAuthorized(res.t('taskApprovalWasNotRequested'));
    }

    // Get Managers
    const managerIds = Object.keys(group.managers);
    managerIds.push(group.leader);
    const managers = await User.find({_id: managerIds}, 'notifications').exec(); // Use this method so we can get access to notifications

    const promises = [];

    // Remove old notifications
    managers.forEach((manager) => {
      let notificationIndex = manager.notifications.findIndex(function findNotification (notification) {
        return notification && notification.data && notification.data.taskId === task._id && notification.type === 'GROUP_TASK_APPROVAL';
      });

      if (notificationIndex !== -1) {
        manager.notifications.splice(notificationIndex, 1);
        promises.push(manager.save());
      }
    });

    task.group.approval.requested = false;
    task.group.approval.requestedDate = undefined;

    const taskText = task.text;
    const managerName = user.profile.name;

    const message = res.t('taskNeedsWork', {taskText, managerName}, assignedUser.preferences.language);

    assignedUser.addNotification('GROUP_TASK_NEEDS_WORK', {
      message,
      task: {
        id: task._id,
        text: taskText,
      },
      group: {
        id: group._id,
        name: group.name,
      },
      manager: {
        id: user._id,
        name: managerName,
      },
    });

    await Promise.all([...promises, assignedUser.save(), task.save()]);

    res.respond(200, task);
  },
};

/**
 * @api {get} /api/v3/approvals/group/:groupId Get a group's approvals
 * @apiVersion 3.0.0
 * @apiName GetGroupApprovals
 * @apiGroup Task
 *
 * @apiParam (Path) {UUID} groupId The id of the group from which to retrieve the approvals
 *
 * @apiSuccess {Array} data An array of tasks
 */
api.getGroupApprovals = {
  method: 'GET',
  url: '/approvals/group/:groupId',
  middlewares: [authWithHeaders()],
  async handler (req, res) {
    req.checkParams('groupId', res.t('groupIdRequired')).notEmpty().isUUID();

    let validationErrors = req.validationErrors();
    if (validationErrors) throw validationErrors;

    let user = res.locals.user;
    let groupId = req.params.groupId;

    let fields = requiredGroupFields.concat(' managers');
    let group = await Group.getGroup({user, groupId, fields});
    if (!group) throw new NotFound(res.t('groupNotFound'));

    if (canNotEditTasks(group, user)) throw new NotAuthorized(res.t('onlyGroupLeaderCanEditTasks'));

    let approvals = await Tasks.Task.find({
      'group.id': groupId,
      'group.approval.approved': false,
      'group.approval.requested': true,
    }, 'userId group text')
      .populate('userId', 'profile')
      .exec();

    res.respond(200, approvals);
  },
};

module.exports = api;
