import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import React, { useCallback } from 'react';
import { type NodeProps } from 'reactflow';
import NodeCard from './render/NodeCard';
import Container from '../components/Container';
import IOTitle from '../components/IOTitle';
import ToolSetList, { getNodeToolSetList } from './components/ToolSetList';
import { useTranslation } from 'next-i18next';
import { useNode } from '@/web/core/workflow/editor';

const NodeToolSet = ({ data, selected }: NodeProps<FlowNodeItemType>) => {
  const { t } = useTranslation();
  const toolList = getNodeToolSetList(data);
  const node = useNode(data.nodeId);
  const onSaveDescription = useCallback(
    (index: number, description: string) => {
      const toolSetKey = (['mcpToolSet', 'httpToolSet', 'systemToolSet'] as const).find(
        (key) => data.toolConfig?.[key]
      );
      if (!toolSetKey || !data.toolConfig) return;

      const toolSet = data.toolConfig[toolSetKey];
      if (!toolSet) return;

      // 工具集描述是节点语义数据（toolConfig）：整块替换后走 updateNode。
      node?.updateNode({
        toolConfig: {
          ...data.toolConfig,
          [toolSetKey]: {
            ...toolSet,
            toolList: (toolSet.toolList ?? []).map((tool, toolIndex) =>
              toolIndex === index ? { ...tool, description } : tool
            )
          }
        }
      });
    },
    [data.toolConfig, node]
  );

  return (
    <NodeCard minW={'350px'} selected={selected} {...data}>
      <Container>
        <ToolSetList
          toolList={toolList}
          onSaveDescription={onSaveDescription}
          title={<IOTitle text={t('app:MCP_tools_list')} {...data} catchError={undefined} />}
        />
      </Container>
    </NodeCard>
  );
};

export default React.memo(NodeToolSet);
