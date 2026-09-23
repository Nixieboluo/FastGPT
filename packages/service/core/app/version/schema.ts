import { defineIndex, connectionMongo, getMongoModel } from '../../../common/mongo';
const { Schema } = connectionMongo;
import { type AppVersionSchemaType } from '@fastgpt/global/core/app/version/type';
import { AppCollectionName, chatConfigType } from '../schema';
import { TeamMemberCollectionName } from '@fastgpt/global/support/user/team/constant';

export const AppVersionCollectionName = 'app_versions';

const AppVersionSchema = new Schema(
  {
    tmbId: {
      type: String,
      ref: TeamMemberCollectionName,
      required: true
    },
    appId: {
      type: Schema.Types.ObjectId,
      ref: AppCollectionName,
      required: true
    },
    time: {
      type: Date,
      default: () => new Date()
    },
    nodes: {
      type: Array,
      default: []
    },
    edges: {
      type: Array,
      default: []
    },
    // 已删除引用来源的历史展示元数据；随版本一起保存，切版本时一并恢复。
    referenceSnapshots: {
      type: Array
    },
    chatConfig: {
      type: chatConfigType
    },
    isPublish: Boolean,
    isAutoSave: Boolean,
    versionName: String,
    resourceRefs: {
      skillIds: {
        type: [String],
        default: []
      }
    }
  },
  {
    minimize: false
  }
);

defineIndex(AppVersionSchema, { key: { appId: 1, time: -1 } });

export const MongoAppVersion = getMongoModel<AppVersionSchemaType>(
  AppVersionCollectionName,
  AppVersionSchema
);
