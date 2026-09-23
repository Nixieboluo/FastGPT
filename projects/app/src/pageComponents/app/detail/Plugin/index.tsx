import React from 'react';
import { ReactFlowCustomProvider } from '../WorkflowComponents/context';
import { useContextSelector } from 'use-context-selector';
import { AppContext, TabEnum } from '../context';
import { useMount } from 'ahooks';
import Header from './Header';
import { Flex } from '@chakra-ui/react';
import { workflowBoxStyles } from '../constants';
import dynamic from 'next/dynamic';
import { cloneDeep } from 'lodash-es';
import { useTranslation } from 'next-i18next';
import { materializeWorkflow } from '@/web/core/workflow/editor/codec';

import Flow from '../WorkflowComponents/Flow';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import { WorkflowUIProvider } from '../WorkflowComponents/Flow/context/workflowUIContext';
import { WorkflowModalProvider } from '../WorkflowComponents/Flow/context/workflowModalContext';

const Logs = dynamic(() => import('../Logs/index'));
const PublishChannel = dynamic(() => import('../Publish'));

const WorkflowEdit = () => {
  const { t } = useTranslation();
  const { appDetail, currentTab } = useContextSelector(AppContext, (e) => e);

  const initRuntime = useContextSelector(WorkflowHostContext, (v) => v.initRuntime);

  useMount(() => {
    initRuntime(
      materializeWorkflow({
        input: {
          nodes: cloneDeep(appDetail.modules || []),
          edges: cloneDeep(appDetail.edges || []),
          referenceSnapshots: cloneDeep(appDetail.referenceSnapshots)
        },
        chatConfig: appDetail.chatConfig,
        t
      })
    );
  });

  // renderer 层交互状态：Header 与画布都要读写弹窗/交互 Context，挂在两者共同祖先。
  return (
    <WorkflowUIProvider>
      <WorkflowModalProvider>
        <Flex {...workflowBoxStyles}>
          <Header />

          {currentTab === TabEnum.appEdit ? (
            <Flow />
          ) : (
            <Flex
              flexDirection={'column'}
              flex={1}
              minH={0}
              mt={'72px'}
              px={4}
              pb={4}
              bg={'white'}
              overflowY={'auto'}
              overflowX={'hidden'}
            >
              {currentTab === TabEnum.publish && <PublishChannel />}
              {currentTab === TabEnum.logs && <Logs />}
            </Flex>
          )}
        </Flex>
      </WorkflowModalProvider>
    </WorkflowUIProvider>
  );
};

const Render = () => {
  return (
    <ReactFlowCustomProvider>
      <WorkflowEdit />
    </ReactFlowCustomProvider>
  );
};

export default Render;
