import React, { useMemo } from 'react';
import type { RenderInputProps } from '../type';
import { Box } from '@chakra-ui/react';
import MySlider from '@/components/Slider';
import { useField } from '@/web/core/workflow/editor';

const SliderRender = ({ item, nodeId }: RenderInputProps) => {
  const field = useField(nodeId, item.key, 'input');

  const Render = useMemo(() => {
    return (
      <Box px={2}>
        <MySlider
          markList={item.markList}
          width={'100%'}
          min={item.min || 0}
          max={item.max}
          step={item.step || 1}
          value={item.value}
          onChange={(e) => {
            field?.setValue(e);
          }}
        />
      </Box>
    );
  }, [field, item]);

  return Render;
};

export default React.memo(SliderRender);
