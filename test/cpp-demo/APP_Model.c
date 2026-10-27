#include "APP_Model.h"

static UINT8 s_output_state = 0u;
UINT8 g_app_model_state = 0u;
APP_ModelState_t g_app_model = {0u, FALSE};

static UINT8 APP_Model_ReadOutput(void)
{
    return s_output_state;
}

static void APP_Model_WriteOutput(UINT8 value)
{
    s_output_state = value;
}

void APP_Model_Set29COutputs(void)
{
    UINT8 u8_temp = 0u;
    BOOL bool_temp = FALSE;

    u8_temp = APP_Model_ReadOutput();
    bool_temp = (u8_temp > 0u);
    APP_Model_WriteOutput(u8_temp);

    if (bool_temp)
    {
        APP_Model_WriteOutput(1u);
    }
}
