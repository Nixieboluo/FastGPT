import React from 'react';
import { appSystemModuleTemplates } from '@fastgpt/global/core/workflow/template/constants';

import { useContextSelector } from 'use-context-selector';
import { AppContext, TabEnum } from '../context';
import { useMount } from 'ahooks';
import Header from './Header';
import { Box, Flex } from '@chakra-ui/react';
import { workflowBoxStyles } from '../constants';
import dynamic from 'next/dynamic';
import { cloneDeep } from 'lodash-es';

import Flow from '../WorkflowComponents/Flow';
import { ReactFlowCustomProvider } from '../WorkflowComponents/context/index';
import { WorkflowUtilsContext } from '../WorkflowComponents/context/workflowUtilsContext';
import { WorkflowUIProvider } from '../WorkflowComponents/Flow/context/workflowUIContext';
import { WorkflowModalProvider } from '../WorkflowComponents/Flow/context/workflowModalContext';

const Logs = dynamic(() => import('../Logs/index'));
const PublishChannel = dynamic(() => import('../Publish'));

const WorkflowEdit = () => {
  const appDetail = useContextSelector(AppContext, (v) => v.appDetail);
  const currentTab = useContextSelector(AppContext, (v) => v.currentTab);

  const initData = useContextSelector(WorkflowUtilsContext, (v) => v.initData);

  useMount(() => {
    initData(
      cloneDeep({
        nodes: appDetail.modules || [],
        edges: appDetail.edges || []
      }),
      true
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
              mt={['8px', '72px']}
              bg={'white'}
              overflowY={'auto'}
              overflowX={'hidden'}
            >
              {currentTab === TabEnum.publish && <PublishChannel />}
              {currentTab === TabEnum.logs && (
                <Box px={4} pb={4} h={'full'}>
                  <Logs />
                </Box>
              )}
            </Flex>
          )}
        </Flex>
      </WorkflowModalProvider>
    </WorkflowUIProvider>
  );
};

const Render = () => {
  return (
    <ReactFlowCustomProvider templates={appSystemModuleTemplates}>
      <WorkflowEdit />
    </ReactFlowCustomProvider>
  );
};

export default Render;
